import { actionFields, type ActionName } from '../contracts/public.js';
import type { Job, Principal, SearchScope, Settings, Turn } from '../domain/entities.js';
import { BackupService } from '../features/backup/backup-service.js';
import { ChatService } from '../features/chat/chat-service.js';
import { CollectionService } from '../features/collections/collection-service.js';
import { DocumentService } from '../features/documents/document-service.js';
import { AccessPolicy } from '../features/identity/access-policy.js';
import { IdentityService } from '../features/identity/identity-service.js';
import { JobService } from '../features/jobs/job-service.js';
import { MonitoringService } from '../features/operations/monitoring-service.js';
import { RetentionService } from '../features/operations/retention-service.js';
import { QualityService } from '../features/quality/quality-service.js';
import { SearchService } from '../features/search/search-service.js';
import { SettingsService } from '../features/settings/settings-service.js';
import { SetupService } from '../features/setup/setup-service.js';
import { SyncService } from '../features/sync/sync-service.js';
import { CacheStore } from '../infrastructure/database/cache-store.js';
import type { Catalog } from '../infrastructure/database/catalog.js';
import { AppError, requireValue } from '../shared/errors.js';
import type { Input } from '../shared/input.js';
import type { ActionMap } from './action-registry.js';
import { DataContext } from './data-context.js';
import { JobScheduler } from './job-scheduler.js';
import type { ModelRuntime } from './ports/model-runtime.js';
import { RuntimeState } from './runtime-state.js';

/** Composition root and request/lifecycle boundary; feature behavior lives in feature services. */
export class Application {
  readonly data: DataContext;
  private readonly state = new RuntimeState();
  private readonly actions: ActionMap;
  private readonly identity: IdentityService;
  private readonly access: AccessPolicy;
  private readonly jobs: JobService;
  private readonly cache: CacheStore;
  private readonly collections: CollectionService;
  private readonly settings: SettingsService;
  private readonly setup: SetupService;
  private readonly documents: DocumentService;
  private readonly search: SearchService;
  private readonly chat: ChatService;
  private readonly quality: QualityService;
  private readonly sync: SyncService;
  private readonly backup: BackupService;
  private readonly monitoring: MonitoringService;
  private readonly retention: RetentionService;
  private readonly scheduler: JobScheduler;
  constructor(catalog: Catalog, models: ModelRuntime, initialSettings: Settings) {
    this.data = new DataContext(catalog, models, initialSettings, this.state);
    this.identity = new IdentityService(this.data);
    this.access = new AccessPolicy(this.data);
    this.jobs = new JobService(this.data, this.access, this.state);
    this.cache = new CacheStore(this.data);
    this.collections = new CollectionService(this.data);
    this.settings = new SettingsService(this.data);
    this.setup = new SetupService(this.data, this.settings);
    this.documents = new DocumentService(this.data, this.access, this.jobs, this.state);
    this.search = new SearchService(this.data, this.access, this.cache);
    this.chat = new ChatService(
      this.access,
      this.data,
      this.jobs,
      this.search,
      this.cache,
      this.documents,
    );
    this.quality = new QualityService(this.data, this.jobs, this.search, this.access);
    this.sync = new SyncService(this.data, this.documents);
    this.backup = new BackupService(this.data, this.state, this.jobs);
    this.monitoring = new MonitoringService(this.data, this.state, this.backup);
    this.retention = new RetentionService(this.data, this.documents);
    this.scheduler = new JobScheduler(
      this.state,
      this.data,
      this.retention,
      this.backup,
      this.sync,
      this.chat,
      this.documents,
      this.quality,
      this.jobs,
    );
    this.actions = {
      ...this.identity.actions,
      ...this.jobs.actions,
      ...this.collections.actions,
      ...this.settings.actions,
      ...this.setup.actions,
      ...this.documents.actions,
      ...this.search.actions,
      ...this.chat.actions,
      ...this.quality.actions,
      ...this.sync.actions,
      ...this.backup.actions,
      ...this.monitoring.actions,
      ...this.retention.actions,
    };
    if (this.data.models.configuration) {
      const runtime = { id: 'runtime', ...this.data.models.configuration() };
      if (JSON.stringify(this.data.catalog.get('system', 'runtime')) !== JSON.stringify(runtime))
        this.data.catalog.invalidate();
      this.data.catalog.put('system', runtime);
    }
    for (const job of this.data.catalog.find<Job>(
      'job',
      "state IN ('extracting','ocr','indexing','searching','generating')",
    ))
      this.jobs.update(job, { status: 'interrupted', error: 'SERVER_RESTARTED' });
    for (const turn of this.data.catalog.find<Turn>(
      'turn',
      "state IN ('queued','searching','generating') AND json_extract(body,'$.job') IN (SELECT id FROM entities WHERE kind='job' AND state='interrupted')",
    )) {
      turn.status = 'interrupted';
      this.data.catalog.put('turn', turn);
    }
  }
  get catalog() {
    return this.data.catalog;
  }
  get auth() {
    return this.data.auth;
  }
  get models() {
    return this.data.models;
  }
  get initialSettings() {
    return this.data.initialSettings;
  }
  get transport() {
    return this.state.transport;
  }
  get initialized() {
    return this.data.initialized;
  }
  get maintenance() {
    return this.state.maintaining;
  }
  readiness() {
    return this.data.readiness();
  }
  start() {
    return this.scheduler.start();
  }
  tick() {
    return this.scheduler.tick();
  }
  jobFor(user: Principal, id: string) {
    return this.jobs.read(user, id);
  }
  original(user: Principal, id: string, version: string) {
    return this.documents.original(user, id, version);
  }
  originalChunk(user: Principal, id: string, version: string, offset: number, length: number) {
    return this.documents.originalChunk(user, id, version, offset, length);
  }
  searchSources(user: Principal, question: string, selection: SearchScope) {
    return this.search.search(user, question, selection);
  }
  exportConversation(user: Principal, id: string) {
    return this.chat.exportConversation(user, id);
  }
  async readOperation<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    requireValue(
      !this.state.maintaining && !this.state.shuttingDown,
      'MAINTENANCE',
      'Выполняется обслуживание.',
      503,
    );
    requireValue(
      this.state.readers.size < 16,
      'DOWNLOAD_BUSY',
      'Слишком много одновременных скачиваний.',
      429,
    );
    const controller = new AbortController(),
      timer = setTimeout(
        () =>
          controller.abort(
            new AppError('DOWNLOAD_TIMEOUT', 'Превышен лимит времени скачивания.', 408),
          ),
        300000,
      );
    this.state.readers.add(controller);
    const operation = Promise.resolve().then(() => work(controller.signal));
    this.state.inflight.add(operation);
    try {
      return await operation;
    } finally {
      clearTimeout(timer);
      this.state.inflight.delete(operation);
      this.state.readers.delete(controller);
    }
  }
  async execute(action: string, input: Input = {}, user?: Principal): Promise<unknown> {
    requireValue(
      !this.state.maintaining && !this.state.shuttingDown,
      'MAINTENANCE',
      'Идёт обслуживание или остановка сервера.',
      503,
    );
    const handler = Object.hasOwn(this.actions, action)
      ? this.actions[action as ActionName]
      : undefined;
    if (!handler) throw new AppError('ACTION_NOT_FOUND', 'Неизвестная команда API.', 404);
    const fields: readonly string[] = actionFields[action as ActionName];
    requireValue(
      fields && Object.keys(input).every((key) => fields.includes(key)),
      'INVALID_INPUT',
      'Команда содержит неподдерживаемые поля.',
    );
    if (!action.startsWith('setup.')) {
      requireValue(user, 'UNAUTHENTICATED', 'Войдите в систему.', 401);
      user = this.auth.current(user.id);
    }
    if (action === 'backup.restore')
      requireValue(
        !this.state.restoreTask,
        'MAINTENANCE_BUSY',
        'Восстановление уже запущено.',
        409,
      );
    const operation = Promise.resolve().then(() => handler(input, user));
    if (action === 'backup.restore') {
      this.state.restoreTask = operation;
      try {
        return await operation;
      } finally {
        this.state.restoreTask = undefined;
      }
    }
    this.state.inflight.add(operation);
    try {
      return await operation;
    } finally {
      this.state.inflight.delete(operation);
    }
  }
  async close() {
    this.state.shuttingDown = true;
    for (const reader of this.state.readers)
      reader.abort(new AppError('SERVER_STOPPING', 'Сервер останавливается.', 503));
    if (this.state.timer) clearInterval(this.state.timer);
    for (const controller of this.state.active.values()) controller.abort();
    while (this.state.active.size) await new Promise<void>((r) => setTimeout(r, 20));
    await Promise.allSettled([...this.state.inflight]);
    await this.state.restoreTask?.catch(() => {});
    try {
      await this.data.models.close();
    } finally {
      this.data.catalog.close();
    }
  }
}
