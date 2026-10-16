export type Role = 'user' | 'editor' | 'admin';
export interface User {
  id: string;
  login: string;
  role: Role;
  blocked: boolean;
  groups: string[];
  revision: number;
}
export interface Principal {
  tenant: string;
  operator: boolean;
  id: string;
  login: string;
  role: Role;
  groups: string[];
}
export interface Collection {
  id: string;
  name: string;
  revision: number;
  grants: { subject: string; access: 'read' | 'edit' }[];
}
export interface CollectionSummary extends Collection {
  documentCount: number;
}
export interface MediaReference {
  kind: 'image' | 'audio' | 'video';
  asset?: string;
  preview?: string;
  startMs?: number;
  endMs?: number;
}
export interface Page {
  number: number;
  text: string;
  method: 'text' | 'ocr' | 'vision' | 'speech';
  media?: MediaReference | undefined;
  warnings: string[];
  sections: { title: string; text: string }[];
  preparedText?: {
    text: string;
    kind: 'description' | 'transcript';
    profile: string;
    model: string;
    provider: AIProvider;
    created: number;
  };
}
export interface DocumentRecord {
  id: string;
  name: string;
  collection: string;
  conversation: string;
  owner: string;
  revision: number;
  activeVersion: string;
  state: 'published' | 'excluded' | 'archived' | 'draft';
}
export interface Version {
  id: string;
  document: string;
  name: string;
  hash: string;
  created: number;
  pages: Page[];
  state: 'pending' | 'review' | 'ready';
  acknowledged: boolean;
  signature: string;
}
export interface Conversation {
  id: string;
  owner: string;
  title: string;
  draft: string;
  selected: string;
  revision: number;
  updated: number;
}
export interface SearchScope {
  collection?: string;
  conversation?: string;
}
export interface Source {
  id: number;
  chunk: string;
  document: string;
  version: string;
  name: string;
  page: number;
  section: string;
  text: string;
  media?: MediaReference | undefined;
}
export type JobStatus =
  | 'queued'
  | 'extracting'
  | 'ocr'
  | 'indexing'
  | 'searching'
  | 'generating'
  | 'complete'
  | 'no_info'
  | 'clarification'
  | 'cancelled'
  | 'interrupted'
  | 'failed'
  | 'retrying';
export interface Job {
  id: string;
  owner: string;
  kind: 'answer' | 'document' | 'evaluation' | 'maintenance';
  status: JobStatus;
  created: number;
  updated: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string;
  diagnostic: string;
  settings: string;
}
export interface Turn {
  id: string;
  conversation: string;
  parent: string;
  replaces: string;
  question: string;
  attachments?: string[];
  answer: string;
  sources: Source[];
  accessSources?: Pick<Source, 'document' | 'version' | 'chunk'>[];
  status: JobStatus;
  job: string;
  created: number;
  scope: SearchScope;
}
export interface Feedback {
  id: string;
  owner: string;
  turn: string;
  rating: number;
  reason: string;
  detail: string;
  created: number;
  sources: Source[];
  settings: string;
}
export interface CheckQuestion {
  id: string;
  revision: number;
  question: string;
  scope: SearchScope;
  documents: string[];
  facts: string[];
  refuse: boolean;
}
export interface SyncFolder {
  id: string;
  path: string;
  collection: string;
  owner: string;
  policy: 'keep' | 'exclude' | 'delete';
  intervalMinutes: number;
  nextRun: number;
  mapping: Record<string, { document: string; hash: string }>;
  revision: number;
}
export interface Settings {
  maxBytes: number;
  maxPages: number;
  maxTextCharacters: number;
  maxChunks: number;
  maxDocuments: number;
  maxQueue: number;
  sessionHours: number;
  historyDays: number;
  jobDays: number;
  tempHours: number;
  logDays: number;
  backupDays: number;
  backupIntervalHours: number;
  pauseIndexing: boolean;
  pauseQueue: boolean;
  pauseIntake: boolean;
  topK: number;
  revision: number;
  generationProfile: string;
  embeddingProfile: string;
  transcriptionProfile: string;
  answerConcurrency: number;
  indexConcurrency: number;
  storageBytes: number;
  monthlyBudgetMicros: number;
  maxOutputTokens: number;
  contextTokens: number;
  cacheSeconds: number;
  prompt: string;
  ocrLanguage: string;
  ocrTimeoutSeconds: number;
  ocrMemoryMB: number;
  whisperLanguage: string;
  whisperThreads: number;
  mediaMaxSeconds: number;
  mediaTimeoutSeconds: number;
  videoMaxFrames: number;
  mediaImageMaxSide: number;
  answerMaxImages: number;
}
export const terminal = new Set<JobStatus>([
  'complete',
  'no_info',
  'clarification',
  'cancelled',
  'interrupted',
  'failed',
]);

export type CredentialProvider = 'google' | 'anthropic' | 'openai-compatible';
export interface AICredential {
  id: string;
  label: string;
  provider: CredentialProvider;
  enabled: boolean;
  revision: number;
  created: number;
  updated: number;
  uses: number;
}
export interface CredentialAudit {
  id: string;
  credential: string;
  action: 'created' | 'updated' | 'rotated' | 'enabled' | 'disabled' | 'deleted';
  enabled: boolean;
  actor: string;
  actorLogin: string;
  created: number;
}
export const actionFields = {
  'answers.create': [
    'conversation',
    'revision',
    'question',
    'replaces',
    'scope',
    'attachments',
    'idempotencyKey',
    'profile',
  ],
  'backup.create': [],
  'backup.list': [],
  'backup.restore': ['id'],
  'backup.verify': ['id'],
  cleanup: [],
  'collections.list': [],
  'collections.rename': ['id', 'revision', 'name'],
  'collections.save': ['id', 'revision', 'name', 'grants'],
  'conversations.create': ['title'],
  'conversations.delete': ['id', 'revision'],
  'conversations.list': ['query', 'page', 'pageSize'],
  'conversations.read': ['id', 'before', 'pageSize'],
  'conversations.variants': ['id', 'parent', 'page', 'pageSize'],
  'conversations.save': ['id', 'revision', 'title', 'draft', 'selected'],
  diagnostics: [],
  'documents.bulk': ['ids', 'revisions', 'operation'],
  'documents.compare': ['id', 'left', 'right'],
  'documents.correct': ['id', 'revision', 'version', 'page', 'text'],
  'documents.delete': ['id', 'revision'],
  'documents.limits': [],
  'documents.list': ['query', 'sort', 'state', 'scope', 'page', 'pageSize'],
  'documents.preview': ['collection', 'conversation', 'files'],
  'documents.publish': ['id', 'revision', 'version', 'acknowledge', 'activate'],
  'documents.read': ['id', 'version'],
  'documents.restore': ['id', 'revision', 'version'],
  'documents.update': ['id', 'revision', 'name', 'state'],
  'documents.upload': ['upload'],
  'uploads.create': [
    'collection',
    'conversation',
    'name',
    'bytes',
    'sha256',
    'document',
    'revision',
  ],
  'uploads.read': ['id'],
  'feedback.create': ['turn', 'rating', 'reason', 'detail'],
  'groups.list': [],
  'groups.save': ['id', 'revision', 'name'],
  'jobs.cancel': ['id'],
  'jobs.retry': ['id'],
  'jobs.list': ['page', 'pageSize'],
  'invitations.list': [],
  'invitations.create': ['login', 'role'],
  'invitations.revoke': ['id'],
  'collections.delete': ['id', 'revision'],
  'tenants.list': [],
  'tenants.create': ['name'],
  'tenants.update': ['id', 'revision', 'name', 'blocked'],
  'secrets.list': [],
  'secrets.save': ['id', 'label', 'provider', 'enabled', 'revision', 'value'],
  'secrets.delete': ['id', 'revision'],
  'secrets.audit': ['page', 'pageSize'],
  'models.list': [],
  'models.save': ['profile'],
  'models.delete': ['id', 'revision'],
  'models.check': ['id'],
  'indexes.list': [],
  'indexes.build': ['profile'],
  'indexes.activate': ['id'],
  'usage.read': [],
  'cache.clear': [],
  'audit.list': ['page', 'pageSize'],
  'jobs.read': ['id'],
  me: [],
  operations: [],
  'password.change': ['oldPassword', 'password'],
  'quality.results': ['job', 'page', 'pageSize'],
  'quality.list': ['page', 'pageSize'],
  'quality.delete': ['id', 'revision'],
  'quality.run': [],
  'quality.save': ['id', 'revision', 'question', 'scope', 'documents', 'facts', 'refuse'],
  search: ['question', 'scope'],
  'sources.read': ['chunk'],
  'sessions.list': [],
  'sessions.revoke': ['id'],
  'settings.read': [],
  'settings.save': ['revision', 'settings'],
  'setup.status': [],
  'sync.delete': ['id', 'revision'],
  'sync.list': [],
  'sync.preview': ['id', 'files'],
  'sync.report': ['id', 'revision', 'mapping'],
  'sync.save': ['id', 'revision', 'collection', 'path', 'policy', 'intervalMinutes'],
  'users.create': ['login', 'password', 'role', 'groups', 'blocked'],
  'users.list': ['query', 'role', 'state', 'ids', 'page', 'pageSize'],
  'users.revoke': ['id'],
  'users.update': ['id', 'revision', 'role', 'blocked', 'password', 'groups'],
} as const;
export type ActionName = keyof typeof actionFields;

export interface Group {
  id: string;
  name: string;
  revision: number;
}
export interface BackupRecord {
  id: string;
  bytes: number;
  created: number;
  verified: boolean;
}
export interface VersionSummary {
  id: string;
  created: number;
  state: Version['state'];
  hash: string;
}
export interface DocumentDetails {
  document: DocumentRecord;
  version: Version;
  versions: VersionSummary[];
}
export interface DocumentPreview {
  name: string;
  status: 'new' | 'update' | 'duplicate' | 'unsupported' | 'limit';
  document?: string;
  revision?: number;
}
export interface DocumentListItem extends DocumentRecord {
  versionCount: number;
  updated: number;
  processing?: {
    id: string;
    status: JobStatus;
    paused?: boolean;
    reviewRequired?: boolean;
    error?: string;
    diagnostic?: string;
  } | null;
}
export interface SourceDetails {
  document: DocumentRecord;
  version: VersionSummary & { name: string };
  page: Page;
  source: Source;
}
export interface TurnVariant {
  id: string;
  parent: string;
  question: string;
  status: JobStatus;
  created: number;
}
export interface ConversationDetails {
  conversation: Conversation;
  turns: (Turn & { redacted?: boolean })[];
  jobs: Job[];
  history: { before: string; hasMore: boolean };
  variantCounts: Record<string, number>;
}

export interface ListPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface PageQuery {
  page?: number;
  pageSize?: number;
  query?: string;
}
export interface ModelHealth {
  embedding: boolean;
  generation: boolean;
  indexSignature: string;
  models: string[];
}
export interface Diagnostics {
  media: { ffmpeg: boolean; ffprobe: boolean; whisper: boolean; model: boolean };
  extraction: {
    pdf: boolean;
    ocr: boolean;
    backend: 'apple-vision' | 'tesseract' | 'unavailable';
    languages: string[];
  };
  dependencies: ModelHealth;
  indexCompatible: boolean;
  directoryWritable: boolean;
  freeBytes: number;
  postgres: boolean;
  redis: boolean;
  storage: boolean;
  workers: { kind: string; lastSeen: number }[];
  ready: boolean;
  hardware: { cpu: string; cores: number; totalMemory: number; freeMemory: number };
  dataDir: string;
}
export interface Operations {
  sse: { streams: number; peakBuffered: number; slowDisconnects: number };
  cpu: { load: number[]; cores: number; process: { user: number; system: number } };
  memory: {
    total: number;
    free: number;
    process: {
      rss: number;
      heapTotal: number;
      heapUsed: number;
      external: number;
      arrayBuffers: number;
    };
  };
  freeBytes: number;
  queue: {
    length: number;
    oldestAgeMs: number;
    lanes: { kind: string; length: number; oldestAgeMs: number }[];
  };
  counts: { users: number; documents: number; conversations: number; collections: number };
  running: Job[];
  response: { meanMs: number; errorRate: number; samples: number; windowHours: number };
  dataBytes: number;
  cacheBytes: number;
  events: number;
  backups: BackupRecord[];
  settings: Settings;
  maintenance: boolean;
}
export interface QualityReport {
  feedback: (Feedback & { question: string; answer: string })[];
  unanswered: Turn[];
  checks: CheckQuestion[];
  runs: Job[];
  totals: { feedback: number; unanswered: number; checks: number; runs: number };
  page: number;
  pageSize: number;
}
export interface EvaluationResult {
  check: string;
  question: string;
  sourceRetrieval: boolean;
  answerFacts: boolean;
  citationsValid: boolean;
  refusalCorrect: boolean;
  milliseconds: number;
  answer: string;
  sources: Source[];
  assessment: string;
}
export interface EvaluationRecord extends EvaluationResult {
  id: string;
  job: string;
  created: number;
  settings: string;
  expected: { documents: string[]; facts: string[]; refuse: boolean };
  error?: { code: string; message: string; diagnostic: string };
  redacted?: boolean;
}
export interface UploadResult {
  document: DocumentRecord;
  version?: Version;
  job?: Job;
  duplicate?: string;
}
export interface SyncPreview {
  policy: SyncFolder['policy'];
  files: { path: string; name: string; hash: string; status: string; document: string }[];
}
export interface BackupVerification {
  id: string;
  integrity: string;
  entities: Record<string, unknown>[];
}
export interface RestoreReport {
  milliseconds: number;
  restored: Record<string, unknown>[];
  backup: string;
  sessionsRevoked: boolean;
  completedJobsPreserved: boolean;
}
export interface Invitation {
  id: string;
  login: string;
  role: Role;
  created: number;
  expires: number;
  used: boolean;
}
export interface ActionInputs {
  'invitations.list': Record<string, never>;
  'invitations.create': { login: string; role: Role };
  'invitations.revoke': { id: string };
  'collections.delete': { id: string; revision: number };
  'answers.create': {
    conversation: string;
    revision: number;
    question: string;
    attachments?: string[];
    scope?: SearchScope;
    replaces?: string;
    idempotencyKey: string;
    profile?: string;
  };
  'backup.create': Record<string, never>;
  'backup.list': Record<string, never>;
  'backup.verify': { id: string };
  'backup.restore': { id: string };
  cleanup: Record<string, never>;
  'collections.list': Record<string, never>;
  'collections.rename': { id: string; revision: number; name: string };
  'collections.save': {
    id?: string;
    revision?: number;
    name: string;
    grants: Collection['grants'];
  };
  'conversations.create': { title?: string };
  'conversations.list': PageQuery;
  'conversations.read': { id: string; before?: string; pageSize?: number };
  'conversations.variants': { id: string; parent: string; page?: number; pageSize?: number };
  'conversations.delete': { id: string; revision: number };
  'conversations.save': {
    id: string;
    revision: number;
    title?: string;
    draft?: string;
    selected?: string;
  };
  diagnostics: Record<string, never>;
  'documents.list': PageQuery & {
    sort?: 'name' | 'state' | 'updated';
    state?: DocumentRecord['state'] | '';
    scope?: SearchScope;
  };
  'documents.limits': Record<string, never>;
  'documents.read': { id: string; version?: string };
  'documents.preview': {
    collection?: string;
    conversation?: string;
    files: { name: string; bytes: number; hash: string }[];
  };
  'documents.upload': { upload: string };
  'uploads.create': {
    collection?: string;
    conversation?: string;
    name: string;
    bytes: number;
    sha256: string;
    document?: string;
    revision?: number;
  };
  'uploads.read': { id: string };
  'documents.update': {
    id: string;
    revision: number;
    name?: string;
    state?: DocumentRecord['state'];
  };
  'documents.delete': { id: string; revision: number };
  'documents.bulk': {
    ids: string[];
    revisions: Record<string, number>;
    operation: 'archive' | 'exclude' | 'delete';
  };
  'documents.compare': { id: string; left: string; right: string };
  'documents.correct': {
    id: string;
    revision: number;
    version: string;
    page: number;
    text: string;
  };
  'documents.restore': { id: string; revision: number; version: string };
  'documents.publish': {
    id: string;
    revision: number;
    version: string;
    acknowledge?: boolean;
    activate?: boolean;
  };
  'feedback.create': {
    turn: string;
    rating: -1 | 1;
    reason: 'wrong_source' | 'outdated' | 'no_answer' | 'irrelevant_answer' | 'other';
    detail?: string;
  };
  'groups.list': Record<string, never>;
  'groups.save': { id?: string; revision?: number; name: string };
  'jobs.read': { id: string };
  'jobs.cancel': { id: string };
  'jobs.retry': { id: string };
  'jobs.list': PageQuery;
  'tenants.list': Record<string, never>;
  'tenants.create': { name: string };
  'tenants.update': { id: string; revision: number; name?: string; blocked?: boolean };
  'secrets.list': Record<string, never>;
  'secrets.save': {
    id: string;
    label: string;
    provider: CredentialProvider;
    enabled: boolean;
    revision: number;
    value?: string;
  };
  'secrets.delete': { id: string; revision: number };
  'secrets.audit': { page?: number; pageSize?: number };
  'models.list': Record<string, never>;
  'models.save': { profile: ModelProfile };
  'models.delete': { id: string; revision: number };
  'models.check': { id: string };
  'indexes.list': Record<string, never>;
  'indexes.build': { profile: string };
  'indexes.activate': { id: string };
  'usage.read': Record<string, never>;
  'cache.clear': Record<string, never>;
  'audit.list': PageQuery;
  me: Record<string, never>;
  operations: Record<string, never>;
  'password.change': { oldPassword: string; password: string };
  'quality.results': PageQuery & { job: string };
  'quality.list': PageQuery;
  'quality.delete': { id: string; revision: number };
  'quality.save': {
    id?: string;
    revision?: number;
    question: string;
    documents: string[];
    facts: string[];
    scope?: SearchScope;
    refuse?: boolean;
  };
  'quality.run': Record<string, never>;
  'sources.read': { chunk: string };
  search: { question: string; scope?: SearchScope };
  'sessions.list': Record<string, never>;
  'sessions.revoke': { id: string };
  'settings.read': Record<string, never>;
  'settings.save': { revision: number; settings: Partial<Settings> };
  'setup.status': Record<string, never>;
  'sync.list': Record<string, never>;
  'sync.save': {
    id?: string;
    revision?: number;
    path: string;
    collection: string;
    policy: SyncFolder['policy'];
    intervalMinutes: number;
  };
  'sync.delete': { id: string; revision: number };
  'sync.preview': {
    id: string;
    files: { path: string; name: string; hash: string; bytes: number }[];
  };
  'sync.report': { id: string; revision: number; mapping: SyncFolder['mapping'] };
  'users.list': PageQuery & { role?: Role | ''; state?: 'active' | 'blocked' | ''; ids?: string[] };
  'users.create': {
    login: string;
    password: string;
    role?: Role;
    groups?: string[];
    blocked?: boolean;
  };
  'users.update': {
    id: string;
    revision: number;
    role?: Role;
    groups?: string[];
    blocked?: boolean;
    password?: string;
  };
  'users.revoke': { id: string };
}
export interface ActionResults {
  'invitations.list': Invitation[];
  'invitations.create': Invitation & { token: string };
  'invitations.revoke': { ok: true };
  'collections.delete': { ok: true };
  'answers.create': { conversation: Conversation; turn: Turn; job: Job };
  'backup.create': Job;
  'backup.list': BackupRecord[];
  'backup.verify': BackupVerification;
  'backup.restore': Job;
  cleanup: Job;
  'collections.list': CollectionSummary[];
  'collections.rename': Collection;
  'collections.save': Collection;
  'conversations.create': Conversation;
  'conversations.list': ListPage<Conversation>;
  'conversations.read': ConversationDetails;
  'conversations.variants': ListPage<TurnVariant>;
  'conversations.save': Conversation;
  'conversations.delete': { ok: boolean };
  diagnostics: Diagnostics;
  'documents.list': ListPage<DocumentListItem>;
  'documents.limits': { maxBytes: number; maxDocuments: number; supported: string[] };
  'documents.read': DocumentDetails;
  'documents.preview': DocumentPreview[];
  'documents.upload': UploadResult;
  'documents.update': DocumentRecord;
  'documents.delete': { ok: boolean };
  'documents.bulk': { count: number };
  'documents.compare': { left: Page[]; right: Page[] };
  'documents.correct': DocumentRecord;
  'documents.restore': DocumentRecord;
  'documents.publish': Job;
  'feedback.create': Feedback;
  'groups.list': Group[];
  'groups.save': Group;
  'jobs.read': Job;
  'jobs.cancel': Job;
  'jobs.retry': Job;
  'jobs.list': ListPage<Job>;
  'tenants.list': Tenant[];
  'tenants.create': Tenant;
  'tenants.update': Tenant;
  'secrets.list': AICredential[];
  'secrets.save': AICredential;
  'secrets.delete': { ok: boolean };
  'secrets.audit': ListPage<CredentialAudit>;
  'models.list': ModelProfile[];
  'models.save': ModelProfile;
  'models.delete': { ok: boolean };
  'models.check': { ok: boolean; message: string };
  'indexes.list': IndexBuild[];
  'indexes.build': Job;
  'indexes.activate': IndexBuild;
  'usage.read': UsageReport;
  'cache.clear': { ok: boolean };
  'audit.list': ListPage<AuditRecord>;
  'uploads.create': UploadSession;
  'uploads.read': UploadSession;
  me: { user: Principal; tenants: Tenant[]; permissionsVersion: number; contentVersion: number };
  operations: Operations;
  'password.change': { ok: boolean };
  'quality.results': ListPage<EvaluationRecord>;
  'quality.list': QualityReport;
  'quality.delete': { ok: boolean };
  'quality.save': CheckQuestion;
  'quality.run': Job;
  'sources.read': SourceDetails;
  search: Source[];
  'sessions.list': { id: string; created: number; expires: number }[];
  'sessions.revoke': { ok: boolean };
  'settings.read': Settings;
  'settings.save': Settings;
  'setup.status': { initialized: boolean };
  'sync.list': SyncFolder[];
  'sync.save': SyncFolder;
  'sync.delete': { ok: boolean };
  'sync.preview': SyncPreview;
  'sync.report': SyncFolder;
  'users.list': ListPage<User>;
  'users.create': User;
  'users.update': User;
  'users.revoke': { ok: boolean };
}

export interface Tenant {
  id: string;
  name: string;
  role: Role;
  blocked: boolean;
  revision: number;
}
export type Modality = 'text' | 'image' | 'audio' | 'video' | 'pdf';
export type AIProvider =
  'google' | 'anthropic' | 'ollama' | 'openai-compatible' | 'whisper' | 'test';
export type BillingModality = 'text' | 'image' | 'audio' | 'video';
export type InputPrices = Record<BillingModality, number>;
export interface BillingBreakdown {
  input: Record<BillingModality, { tokens: number; costMicros: number }>;
  unattributed: { tokens: number; costMicros: number; rateMicrosPerMillion: number };
  output: { tokens: number; costMicros: number };
  prices: InputPrices;
  outputPrice: number;
  estimated: boolean;
  costMicros: number;
}
export interface ModelProfile {
  id: string;
  revision: number;
  name: string;
  provider: AIProvider;
  role: 'generation' | 'embedding' | 'transcription';
  model: string;
  endpoint: string;
  secretRef: string;
  input: Modality[];
  dimensions: number;
  contextTokens: number;
  maxOutputTokens: number;
  maxBytes: number;
  maxSeconds: number;
  concurrency: number;
  requestsPerMinute: number;
  tokensPerMinute: number;
  inputMicrosPerMillion: InputPrices;
  outputMicrosPerMillion: number;
  timeoutMs: number;
  cache: boolean;
  enabled: boolean;
}
export interface IndexBuild {
  id: string;
  profile: string;
  state: 'building' | 'ready' | 'active' | 'failed';
  created: number;
  documents: number;
  signature: string;
}
export interface UploadSession {
  id: string;
  name: string;
  bytes: number;
  offset: number;
  partBytes: number;
  state: 'uploading' | 'ready' | 'consumed';
  sha256: string;
}
export interface UsageReport {
  month: string;
  spentMicros: number;
  reservedMicros: number;
  uncertainMicros: number;
  storageBytes: number;
  budgetMicros: number;
  calls: {
    profile: string;
    calls: number;
    input: number;
    output: number;
    costMicros: number;
    estimatedCalls: number;
    modalities: Record<BillingModality | 'unattributed', { tokens: number; costMicros: number }>;
  }[];
}
export interface AuditRecord {
  id: string;
  actor: string;
  action: string;
  created: number;
  target: string;
}
export interface ContentPart {
  kind: Modality;
  text?: string;
  asset?: string;
  startMs?: number;
  endMs?: number;
}
