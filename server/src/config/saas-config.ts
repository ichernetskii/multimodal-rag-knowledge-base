import { resolve } from 'node:path';
import { requireValue } from '../shared/errors.js';

export interface DeploymentConfig {
  databaseUrl: string;
  adminDatabaseUrl: string;
  redisUrl: string;
  storage: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  host: string;
  port: number;
  origin: string;
  tempDir: string;
  environment: 'development' | 'test' | 'production';
  worker: 'all' | 'answer' | 'document' | 'evaluation' | 'maintenance';
  answerConcurrency: number;
  indexConcurrency: number;
  processingConcurrency: number;
  requestTimeoutMs: number;
  encryptionKey: string;
  allowTestAI: boolean;
  profileDefaults: { generation: string; embedding: string; transcription: string };
}
export function loadDeployment(env: NodeJS.ProcessEnv = process.env): DeploymentConfig {
  const environment =
    env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const integer = (name: string, fallback: number, max = 1024) => {
    const value = Number(env[name] ?? fallback);
    requireValue(
      Number.isSafeInteger(value) && value > 0 && value <= max,
      'INVALID_CONFIG',
      `${name}: invalid positive integer.`,
    );
    return value;
  };
  const encryptionKey = env.APP_ENCRYPTION_KEY ?? '';
  requireValue(
    /^[a-f0-9]{64}$/iu.test(encryptionKey) && !/^0+$/u.test(encryptionKey),
    'INVALID_CONFIG',
    'APP_ENCRYPTION_KEY must contain 32 random bytes encoded as hex.',
  );
  if (environment === 'production') {
    for (const key of [
      'DATABASE_URL',
      'REDIS_URL',
      'S3_ENDPOINT',
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
      'RAG_PUBLIC_ORIGIN',
    ])
      requireValue(env[key], 'INVALID_CONFIG', key + ' is required in production.');
    requireValue(
      env.ALLOW_TEST_AI !== '1' &&
        env.DEFAULT_GENERATION_PROVIDER !== 'test' &&
        env.DEFAULT_EMBEDDING_PROVIDER !== 'test',
      'INVALID_CONFIG',
      'TEST AI is forbidden in production.',
    );
    requireValue(
      env.RAG_PUBLIC_ORIGIN?.startsWith('https://'),
      'INVALID_CONFIG',
      'Production requires an HTTPS public origin.',
    );
  }
  requireValue(
    ['google', 'test', 'anthropic', 'ollama'].includes(
      env.DEFAULT_GENERATION_PROVIDER ?? 'google',
    ) &&
      ['google', 'test', 'ollama'].includes(env.DEFAULT_EMBEDDING_PROVIDER ?? 'google') &&
      ['', 'whisper', 'google'].includes(env.DEFAULT_TRANSCRIPTION_PROVIDER ?? ''),
    'INVALID_CONFIG',
    'Unsupported default provider.',
  );
  const worker = env.WORKER_KIND ?? 'all';
  requireValue(
    ['all', 'answer', 'document', 'evaluation', 'maintenance'].includes(worker),
    'INVALID_CONFIG',
    'Invalid WORKER_KIND.',
  );
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://rag_app:local-rag-app@127.0.0.1:5432/rag',
    adminDatabaseUrl:
      env.DATABASE_ADMIN_URL ?? 'postgres://postgres:local-rag-admin@127.0.0.1:5432/rag',
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    storage: {
      endpoint: env.S3_ENDPOINT ?? 'http://127.0.0.1:8333',
      region: env.S3_REGION ?? 'us-east-1',
      bucket: env.S3_BUCKET ?? 'rag',
      accessKeyId: env.S3_ACCESS_KEY ?? 'local-rag',
      secretAccessKey: env.S3_SECRET_KEY ?? 'local-rag-storage',
    },
    host: env.RAG_HOST ?? '127.0.0.1',
    port: integer('RAG_PORT', 3210, 65535),
    origin: env.RAG_PUBLIC_ORIGIN ?? 'http://localhost:5173',
    tempDir: resolve(env.RAG_TEMP_DIR ?? '/tmp/local-rag'),
    environment,
    worker: worker as DeploymentConfig['worker'],
    answerConcurrency: integer('ANSWER_CONCURRENCY', 4, 64),
    indexConcurrency: integer('INDEX_CONCURRENCY', 2, 32),
    processingConcurrency: integer('PROCESSING_CONCURRENCY', 1, 16),
    requestTimeoutMs: integer('AI_TIMEOUT_MS', 300000, 3600000),
    encryptionKey,
    allowTestAI: env.ALLOW_TEST_AI === '1' && environment !== 'production',
    profileDefaults: {
      generation: env.DEFAULT_GENERATION_PROVIDER ?? 'google',
      embedding: env.DEFAULT_EMBEDDING_PROVIDER ?? 'google',
      transcription: env.DEFAULT_TRANSCRIPTION_PROVIDER ?? '',
    },
  };
}
