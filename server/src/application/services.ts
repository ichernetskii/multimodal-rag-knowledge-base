import type { Database } from '../infrastructure/database/postgres.js';
import type { SharedCache } from '../infrastructure/cache/redis-cache.js';
import type { ObjectStore } from '../infrastructure/storage/s3-store.js';
import type { Identity } from '../features/identity/saas-identity.js';
import type { AIService } from '../features/models/ai-service.js';
import type { JobQueue } from './job-queue.js';
import type { DeploymentConfig } from '../config/saas-config.js';
export interface Services {
  db: Database;
  cache: SharedCache;
  storage: ObjectStore;
  identity: Identity;
  ai: AIService;
  queue: JobQueue;
  config: DeploymentConfig;
}
