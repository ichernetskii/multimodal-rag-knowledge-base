import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Pool } from 'pg';
import {
  AbortMultipartUploadCommand,
  DeleteBucketCommand,
  ListMultipartUploadsCommand,
} from '@aws-sdk/client-s3';
import { openApplication } from '../../server/src/app/bootstrap.ts';
import { loadDeployment, type DeploymentConfig } from '../../server/src/config/saas-config.ts';
import type { Application } from '../../server/src/application/application.ts';
import { ObjectStore } from '../../server/src/infrastructure/storage/s3-store.ts';

/** The configured development database is never reset or opened with the test schema. */
export async function isolatedDatabase<T>(
  work: (app: Application, config: DeploymentConfig) => Promise<T>,
) {
  if (existsSync(new URL('../../.env', import.meta.url)))
    process.loadEnvFile(new URL('../../.env', import.meta.url));
  const baseline = loadDeployment();
  const source = new URL(baseline.adminDatabaseUrl);
  if (!['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(source.hostname))
    throw new Error(
      'Isolated tests run on local infrastructure. Set DATABASE_ADMIN_URL to a test PostgreSQL instance.',
    );
  const name = 'rag_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: baseline.adminDatabaseUrl, max: 1 });
  const databaseUrl = new URL(baseline.databaseUrl),
    adminDatabaseUrl = new URL(baseline.adminDatabaseUrl);
  databaseUrl.pathname = '/' + name;
  adminDatabaseUrl.pathname = '/' + name;
  const config: DeploymentConfig = {
    ...baseline,
    databaseUrl: databaseUrl.toString(),
    adminDatabaseUrl: adminDatabaseUrl.toString(),
    storage: { ...baseline.storage, bucket: name.replaceAll('_', '-') },
    environment: 'test',
    allowTestAI: true,
    profileDefaults: { generation: 'test', embedding: 'test', transcription: '' },
  };
  const storage = new ObjectStore(config.storage);
  let bucketCreated = false;
  let application: Application | undefined;
  try {
    await admin.query('CREATE DATABASE "' + name + '"');
    await storage.initialize();
    bucketCreated = true;
    application = await openApplication(config, true);
    await application.s.identity.bootstrap('admin', 'local-development-only', 'QA workspace');
    return await work(application, config);
  } finally {
    try {
      await application?.close();
    } finally {
      try {
        if (bucketCreated) {
          const uploads = await storage.client.send(
            new ListMultipartUploadsCommand({ Bucket: storage.bucket }),
          );
          for (const upload of uploads.Uploads ?? [])
            if (upload.Key && upload.UploadId)
              await storage.client.send(
                new AbortMultipartUploadCommand({
                  Bucket: storage.bucket,
                  Key: upload.Key,
                  UploadId: upload.UploadId,
                }),
              );
          for (const key of await storage.keys('')) await storage.remove(key);
          await storage.client.send(new DeleteBucketCommand({ Bucket: storage.bucket }));
        }
      } finally {
        storage.close();
        try {
          await admin.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
        } finally {
          await admin.end();
        }
      }
    }
  }
}
