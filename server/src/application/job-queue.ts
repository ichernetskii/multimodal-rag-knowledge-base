import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import type { JobWithMetadata } from 'pg-boss';
import type { Database } from '../infrastructure/database/postgres.js';
import type { SharedCache } from '../infrastructure/cache/redis-cache.js';
import type { Identity } from '../features/identity/saas-identity.js';
import type { DeploymentConfig } from '../config/saas-config.js';
import type { Job, Principal, Settings, Turn } from '../contracts/public.js';
import { terminal } from '../contracts/public.js';
import { errorResponse, requireValue } from '../shared/errors.js';
import { Resources } from './resources.js';
export interface JobPayload {
  tenant: string;
  id: string;
}
export class JobQueue {
  readonly boss: PgBoss;
  readonly workerId = randomUUID();
  private active = new Map<string, AbortController>();
  private maintenance: ReturnType<typeof setInterval> | undefined;
  schedule: (() => Promise<void>) | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  handler:
    | ((job: Job, user: Principal, signal: AbortSignal, attempt: string) => Promise<void>)
    | undefined;
  constructor(
    readonly db: Database,
    private readonly identity: Identity,
    private readonly cache: SharedCache,
    private readonly config: DeploymentConfig,
  ) {
    this.boss = new PgBoss({
      connectionString: config.databaseUrl,
      schema: 'pgboss',
      useListenNotify: true,
      max: 4,
    });
    this.boss.on('error', () => console.error('Queue operation failed'));
  }
  async start() {
    await this.boss.start();
    await this.boss.createQueue('rag-dead', { retentionSeconds: 2592000 });
    for (const kind of ['answer', 'document', 'evaluation', 'maintenance'])
      await this.boss.createQueue('rag-' + kind, {
        notify: true,
        heartbeatSeconds: 20,
        retryLimit: 5,
        retryDelay: 2,
        retryBackoff: true,
        expireInSeconds: 1800,
        retentionSeconds: 2592000,
        deadLetter: 'rag-dead',
      });
  }
  async create(kind: Job['kind'], payload: Record<string, unknown>, user: Principal) {
    return this.db.transaction(async () => {
      await this.db.lock('admission');
      const settings = await this.identity.settings();
      requireValue(!settings.pauseIntake, 'INTAKE_PAUSED', 'New jobs are paused.', 503);
      const count = await this.db.count(
        'job',
        "body->>'status' NOT IN ('complete','no_info','clarification','cancelled','interrupted','failed')",
      );
      requireValue(count < settings.maxQueue, 'QUEUE_FULL', 'Company queue is full.', 429);
      const job: Job = {
        id: randomUUID(),
        owner: user.id,
        kind,
        status: 'queued',
        created: Date.now(),
        updated: Date.now(),
        payload,
        result: {},
        error: '',
        diagnostic: '',
        settings: JSON.stringify(settings),
      };
      await this.db.put('job', job);
      await this.enqueue(job, settings);
      return job;
    });
  }
  async enqueue(job: Job, settings: Settings) {
    const connection = this.db.client;
    await this.boss.send(
      'rag-' + job.kind,
      { tenant: this.db.tenantId, id: job.id },
      {
        id: job.id,
        group: {
          id: this.db.tenantId,
          tier: String(
            job.kind === 'answer' ? settings.answerConcurrency : settings.indexConcurrency,
          ),
        },
        db: { executeSql: async (text, values) => connection.query(text, values) },
      },
    );
  }
  async update(id: string, change: Partial<Job>, attempt?: string) {
    return this.db.transaction(async () => {
      await this.db.query('SELECT id FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
        this.db.tenantId,
        id,
      ]);
      const job = await this.db.get<Job>('job', id);
      requireValue(job, 'JOB_GONE', 'Job was removed.', 409);
      if (attempt) {
        const rows = await this.db.query(
          'SELECT 1 FROM job_attempts WHERE tenant_id=$1 AND job_id=$2 AND token=$3 AND expires>$4',
          [this.db.tenantId, id, attempt, Date.now()],
        );
        requireValue(
          rows.length && !terminal.has(job.status),
          'STALE_ATTEMPT',
          'Job attempt is no longer active.',
          409,
        );
      }
      Object.assign(job, change, { updated: Math.max(Date.now(), job.updated + 1) });
      await this.db.put('job', job);
      if (
        job.kind === 'maintenance' &&
        job.payload.operation === 'backup' &&
        ['failed', 'interrupted', 'cancelled'].includes(job.status)
      ) {
        const backup = await this.db.get<{ id: string; state: string }>(
          'backup',
          String(job.payload.backup),
        );
        if (backup) await this.db.put('backup', { ...backup, state: 'failed' });
      }
      if (job.kind === 'answer' && change.status) {
        const turn = await this.db.get<Turn>('turn', String(job.payload.turn));
        if (turn && turn.job === job.id) await this.db.put('turn', { ...turn, status: job.status });
      }
      await this.cache.notify(this.db.tenantId, id);
      return job;
    });
  }
  async read(user: Principal, id: string) {
    const job = await this.db.get<Job>('job', id);
    requireValue(
      job && (job.owner === user.id || user.role === 'admin'),
      'NOT_FOUND',
      'Job not found.',
      404,
    );
    return job;
  }
  async cancel(user: Principal, id: string) {
    const job = await this.read(user, id);
    if (terminal.has(job.status)) return job;
    await this.db.transaction(async () => {
      await this.db.query('SELECT id FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
        this.db.tenantId,
        id,
      ]);
      const current = await this.read(user, id);
      if (terminal.has(current.status)) return;
      await this.db.query('DELETE FROM job_attempts WHERE tenant_id=$1 AND job_id=$2', [
        this.db.tenantId,
        id,
      ]);
      await this.update(id, { status: 'cancelled' });
      const c = this.db.client;
      await this.boss.cancel('rag-' + job.kind, id, {
        db: { executeSql: async (text, values) => c.query(text, values) },
      });
    });
    this.active.get(id)?.abort();
    return (await this.db.get<Job>('job', id))!;
  }
  async retry(user: Principal, id: string) {
    const old = await this.read(user, id);
    requireValue(
      ['failed', 'interrupted'].includes(old.status),
      'JOB_NOT_RETRYABLE',
      'Only failed or interrupted jobs can be retried.',
      409,
    );
    return this.db.transaction(async () => {
      await this.db.lock('answer');
      const next = await this.create(old.kind, { ...old.payload, retryOf: old.id }, user);
      if (old.kind === 'answer') {
        const turn = await this.db.get<Turn>('turn', String(old.payload.turn));
        requireValue(
          turn && turn.job === old.id,
          'JOB_SUPERSEDED',
          'This answer has already been retried.',
          409,
        );
        await this.db.put('turn', {
          ...turn,
          job: next.id,
          status: 'queued',
          answer: '',
          sources: [],
        });
      }
      return next;
    });
  }
  async runWorker() {
    const tiers = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [String(i + 1), i + 1]));
    for (const kind of ['answer', 'document', 'evaluation', 'maintenance'] as const) {
      if (this.config.worker !== 'all' && this.config.worker !== kind) continue;
      const concurrency =
        kind === 'answer'
          ? this.config.answerConcurrency
          : kind === 'maintenance'
            ? 1
            : this.config.indexConcurrency;
      await this.boss.work<JobPayload, unknown>(
        'rag-' + kind,
        {
          includeMetadata: true,
          localConcurrency: concurrency,
          groupConcurrency: { default: 1, tiers },
          pollingIntervalSeconds: 0.5,
          // NOTIFY can coalesce a backlog; pg-boss otherwise polls only every 30 seconds.
          // Bound pickup latency even when no producer wakes a single-slot worker.
          notifyPollingIntervalSeconds: 1,
        },
        async (jobs) => {
          for (const job of jobs) await this.process(job as JobWithMetadata<JobPayload>);
        },
      );
    }
    if (this.config.worker === 'all' || this.config.worker === 'maintenance') {
      const tick = () => {
        void this.schedule?.().catch(() => console.error('Scheduled maintenance failed'));
      };
      this.maintenance = setInterval(tick, 30000);
      this.maintenance.unref();
      tick();
    }
    const beat = async () => {
      await this.db.query(
        'INSERT INTO workers VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen',
        [this.workerId, this.config.worker, Date.now()],
      );
    };
    await beat();
    this.heartbeat = setInterval(() => {
      void beat().catch(() => {});
    }, 5000);
    this.heartbeat.unref();
  }
  private async process(item: JobWithMetadata<JobPayload>) {
    await this.db.tenant(item.data.tenant, '', async () => {
      const job = await this.db.get<Job>('job', item.data.id);
      if (!job || terminal.has(job.status)) return;
      const controller = new AbortController();
      this.active.set(job.id, controller);
      const attempt = randomUUID();
      let timer: ReturnType<typeof setInterval> | undefined,
        release: (() => Promise<void>) | undefined;
      try {
        const user = await this.identity.current(job.owner, item.data.tenant);
        const unfinished = await this.db.query(
          "UPDATE usage_ledger SET state='uncertain' WHERE tenant_id=$1 AND job_id=$2 AND state='reserved' RETURNING id",
          [user.tenant, job.id],
        );
        requireValue(
          !unfinished.length,
          'PROVIDER_OUTCOME_UNCERTAIN',
          'A previous process stopped during an AI request. Review provider usage before retrying.',
          409,
        );
        const [tenant] = await this.db.query<{ maintenance: boolean }>(
          'SELECT maintenance FROM tenants WHERE id=$1',
          [user.tenant],
        );
        requireValue(!tenant?.maintenance, 'QUEUE_PAUSED', 'Company restore is in progress.', 503);
        const settings = await this.identity.settings();
        if (settings.pauseQueue || (job.kind === 'document' && settings.pauseIndexing))
          throw Object.assign(new Error('Queue paused'), { code: 'QUEUE_PAUSED' });
        const resources = new Resources(this.db);
        release = await resources.acquire(
          [
            {
              key: 'deployment:' + job.kind,
              limit:
                job.kind === 'answer'
                  ? this.config.answerConcurrency
                  : this.config.indexConcurrency,
            },
            {
              key: `tenant:${user.tenant}:${job.kind}`,
              limit: job.kind === 'answer' ? settings.answerConcurrency : settings.indexConcurrency,
            },
          ],
          controller.signal,
        );
        await this.db.query(
          'INSERT INTO job_attempts VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,job_id) DO UPDATE SET token=excluded.token,expires=excluded.expires',
          [user.tenant, job.id, attempt, Date.now() + 15000],
        );
        const refresh = async () => {
          const current = await this.db.get<Job>('job', job.id);
          if (!current || terminal.has(current.status)) {
            controller.abort();
            return;
          }
          await this.identity.current(user.id, user.tenant);
          const rows = await this.db.query(
            'UPDATE job_attempts SET expires=$1 WHERE tenant_id=$2 AND job_id=$3 AND token=$4 RETURNING token',
            [Date.now() + 15000, user.tenant, job.id, attempt],
          );
          if (!rows.length) controller.abort();
        };
        timer = setInterval(() => {
          void refresh().catch(() => controller.abort());
        }, 1000);
        timer.unref();
        requireValue(this.handler, 'WORKER_NOT_READY', 'Worker handler not registered.');
        await this.handler(job, user, controller.signal, attempt);
      } catch (e) {
        const current = await this.db.get<Job>('job', job.id);
        if (!current || terminal.has(current.status)) return;
        const error = errorResponse(e);
        const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : error.error.code;
        const uncertain = await this.db.query(
          "SELECT 1 FROM usage_ledger WHERE tenant_id=$1 AND job_id=$2 AND state='uncertain' LIMIT 1",
          [this.db.tenantId, job.id],
        );
        const retryable =
          ['CAPACITY_BUSY', 'PROVIDER_RATE_LIMIT', 'QUEUE_PAUSED'].includes(code) &&
          !uncertain.length &&
          item.retryCount < item.retryLimit;
        await this.update(job.id, {
          status: retryable ? 'retrying' : controller.signal.aborted ? 'interrupted' : 'failed',
          error: code,
          diagnostic: error.error.diagnostic,
          result: {
            ...current.result,
            message: uncertain.length
              ? 'Provider outcome is uncertain. Review usage before retrying.'
              : error.error.message,
          },
        });
        if (retryable) throw e;
      } finally {
        if (timer) clearInterval(timer);
        this.active.delete(job.id);
        await this.db.query(
          'DELETE FROM job_attempts WHERE tenant_id=$1 AND job_id=$2 AND token=$3',
          [this.db.tenantId, job.id, attempt],
        );
        await release?.();
      }
    });
  }
  async close() {
    if (this.maintenance) clearInterval(this.maintenance);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.active.values()) c.abort();
    await this.boss.stop({ graceful: true, timeout: 10000 });
    await this.db.query('DELETE FROM workers WHERE id=$1', [this.workerId]);
  }
}
