import { mkdir } from 'node:fs/promises';
import { Database } from '../infrastructure/database/postgres.js';
import { ObjectStore } from '../infrastructure/storage/s3-store.js';
import { SharedCache } from '../infrastructure/cache/redis-cache.js';
import { Identity } from '../features/identity/saas-identity.js';
import { AIService } from '../features/models/ai-service.js';
import { JobQueue } from '../application/job-queue.js';
import { Application } from '../application/application.js';
import { loadDeployment } from '../config/saas-config.js';
import type { DeploymentConfig } from '../config/saas-config.js';
export async function openApplication(
  config: DeploymentConfig = loadDeployment(),
  initialize = false,
) {
  await mkdir(config.tempDir, { recursive: true, mode: 0o700 });
  const db = new Database(config.databaseUrl),
    storage = new ObjectStore(config.storage),
    cache = new SharedCache(config.redisUrl);
  let queue: JobQueue | undefined;
  try {
    if (initialize) {
      await db.initialize(config.adminDatabaseUrl);
      await storage.initialize();
    } else await db.verify();
    await cache.start();
    const identity = new Identity(db, config),
      ai = new AIService(db, identity, cache, config);
    queue = new JobQueue(db, identity, cache, config);
    await queue.start();
    return new Application({ db, storage, cache, identity, ai, queue, config });
  } catch (e) {
    await queue?.close().catch(() => {});
    await cache.close();
    storage.close();
    await db.close();
    throw e;
  }
}
