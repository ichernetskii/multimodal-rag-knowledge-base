import type { Job, SyncFolder, Turn } from '../domain/entities.js';
import type { BackupService } from '../features/backup/backup-service.js';
import type { ChatService } from '../features/chat/chat-service.js';
import type { DocumentService } from '../features/documents/document-service.js';
import type { JobService } from '../features/jobs/job-service.js';
import type { RetentionService } from '../features/operations/retention-service.js';
import type { QualityService } from '../features/quality/quality-service.js';
import type { SyncService } from '../features/sync/sync-service.js';
import { errorResponse } from '../shared/errors.js';
import { string } from '../shared/input.js';
import type { DataContext } from './data-context.js';
import type { RuntimeState } from './runtime-state.js';

export class JobScheduler {
  constructor(
    private readonly state: RuntimeState,
    private readonly data: DataContext,
    private readonly retention: RetentionService,
    private readonly backup: BackupService,
    private readonly sync: SyncService,
    private readonly chat: ChatService,
    private readonly documents: DocumentService,
    private readonly quality: QualityService,
    private readonly jobs: JobService,
  ) {}

  start() {
    this.state.timer = setInterval(() => {
      void this.tick().catch((error) => {
        const e = errorResponse(error);
        this.data.catalog.log(e.error.code, e.error.diagnostic);
      });
    }, 250);
    this.state.timer.unref();
  }

  async tick() {
    if (
      this.state.ticking ||
      this.state.maintaining ||
      this.state.shuttingDown ||
      !this.data.initialized
    )
      return;
    this.state.ticking = true;
    try {
      const settings = this.data.catalog.settings();
      if (Date.now() >= this.state.nextCleanup) {
        this.state.nextCleanup = Date.now() + 3600_000;
        this.retention.cleanup();
      }
      if (!settings.pauseQueue)
        for (const lane of ['answer', 'document', 'evaluation'] as const) {
          if (lane === 'document' && settings.pauseIndexing) continue;
          if (
            [...this.state.active.keys()].some(
              (id) => this.data.catalog.get<Job>('job', id)?.kind === lane,
            )
          )
            continue;
          const job = this.data.catalog.find<Job>(
            'job',
            "job_kind=? AND state='queued'",
            [lane],
            'created',
            1,
          )[0];
          if (job) {
            const controller = new AbortController();
            this.state.active.set(job.id, controller);
            void this.run(job, controller);
          }
        }
      if (
        !this.state.backupRunning &&
        settings.backupIntervalHours > 0 &&
        Date.now() >= settings.nextBackup
      ) {
        settings.nextBackup = Date.now() + settings.backupIntervalHours * 3600_000;
        this.data.catalog.setSettings(settings);
        const task = this.backup.create();
        this.state.inflight.add(task);
        void task
          .catch((error) => {
            const e = errorResponse(error);
            this.data.catalog.log(e.error.code, e.error.diagnostic);
          })
          .finally(() => this.state.inflight.delete(task));
      }
      for (const sync of this.data.catalog.list<SyncFolder>('sync'))
        if (sync.intervalMinutes > 0 && sync.nextRun <= Date.now()) {
          sync.nextRun = Date.now() + sync.intervalMinutes * 60_000;
          this.data.catalog.put('sync', sync);
          try {
            const task = this.sync.run(this.data.auth.current(sync.owner), sync);
            this.state.inflight.add(task);
            void task
              .catch((error) => {
                const e = errorResponse(error);
                this.data.catalog.log(e.error.code, e.error.diagnostic);
              })
              .finally(() => this.state.inflight.delete(task));
          } catch (error) {
            const e = errorResponse(error);
            this.data.catalog.log(e.error.code, e.error.diagnostic);
          }
        }
    } finally {
      this.state.ticking = false;
    }
  }

  async run(job: Job, controller: AbortController) {
    try {
      const user = this.data.auth.current(job.owner);
      if (job.kind === 'answer') await this.chat.process(job, user, controller.signal);
      else if (job.kind === 'document') await this.documents.process(job, user, controller.signal);
      else await this.quality.process(job, user, controller.signal);
    } catch (error) {
      const e = errorResponse(error);
      const exists = this.data.catalog.get<Job>('job', job.id);
      if (exists)
        try {
          const status =
            exists.result.reason === 'SOURCE_DELETED'
              ? 'interrupted'
              : controller.signal.aborted
                ? this.state.shuttingDown || this.state.maintaining
                  ? 'interrupted'
                  : 'cancelled'
                : 'failed';
          job.payload.paused = false;
          this.jobs.update(job, {
            status,
            error: controller.signal.aborted ? '' : e.error.code,
            diagnostic: controller.signal.aborted ? '' : e.error.diagnostic,
            result: controller.signal.aborted ? {} : { message: e.error.message },
          });
          if (!controller.signal.aborted) this.data.catalog.log(e.error.code, e.error.diagnostic);
          if (job.kind === 'answer') {
            const t = this.data.catalog.get<Turn>('turn', string(job.payload, 'turn'));
            if (t) {
              t.status = status;
              this.data.catalog.put('turn', t);
            }
          }
        } catch {
          /* A full disk can prevent writing the failure; startup marks unfinished work interrupted. */
        }
    } finally {
      this.state.active.delete(job.id);
    }
  }
}
