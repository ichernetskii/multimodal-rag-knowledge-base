import { randomBytes } from 'node:crypto';
import { writeFile, access } from 'node:fs/promises';
const file = new URL('../.env', import.meta.url);
if (
  await access(file).then(
    () => true,
    () => false,
  )
)
  throw new Error('.env already exists. Edit it explicitly; secrets will not be overwritten.');
const production = process.argv.includes('--production');
const localAI = process.argv.includes('--local-ai');
const secret = () => randomBytes(24).toString('hex');
const admin = secret(),
  app = secret(),
  redis = secret(),
  storage = secret();
const values: Record<string, string> = {
  NODE_ENV: production ? 'production' : 'development',
  POSTGRES_ADMIN_PASSWORD: admin,
  POSTGRES_APP_PASSWORD: app,
  REDIS_PASSWORD: redis,
  S3_ACCESS_KEY: 'local-rag',
  S3_SECRET_KEY: storage,
  APP_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  DATABASE_URL: `postgres://rag_app:${app}@127.0.0.1:5432/rag`,
  DATABASE_ADMIN_URL: `postgres://postgres:${admin}@127.0.0.1:5432/rag`,
  REDIS_URL: `redis://:${redis}@127.0.0.1:6379`,
  S3_ENDPOINT: 'http://127.0.0.1:8333',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'rag',
  AI_ALLOWED_ENDPOINTS: '',
  ALLOW_TEST_AI: production || localAI ? '0' : '1',
  DEFAULT_GENERATION_PROVIDER: localAI ? 'ollama' : production ? 'google' : 'test',
  DEFAULT_EMBEDDING_PROVIDER: localAI ? 'ollama' : production ? 'google' : 'test',
  DEFAULT_TRANSCRIPTION_PROVIDER: localAI ? 'whisper' : '',
  LOCAL_AI: localAI ? '1' : '0',
  DOCKER_OLLAMA_URL: 'http://ollama:11434',
  OLLAMA_URL: 'http://127.0.0.1:11435',
  OLLAMA_PORT: '11435',
  RAG_HOST: '127.0.0.1',
  RAG_PORT: '3210',
  RAG_PUBLIC_ORIGIN: production ? 'https://rag.example.com' : 'http://localhost:5173',
  DOCKER_PUBLIC_ORIGIN: production ? 'https://rag.example.com' : 'http://localhost:8080',
  TLS_DOMAIN: 'rag.example.com',
  HTTP_BIND: '127.0.0.1',
  HTTP_PORT: '8080',
  ANSWER_CONCURRENCY: '4',
  INDEX_CONCURRENCY: '2',
  PROCESSING_CONCURRENCY: '1',
};
await writeFile(
  file,
  Object.entries(values)
    .map(([k, v]) => `${k}='${v.replaceAll("'", "\\'")}'`)
    .join('\n') + '\n',
  { mode: 0o600, flag: 'wx' },
);
console.log(
  `Created private .env for ${localAI ? 'local AI in Docker (Qwen, EmbeddingGemma and Whisper)' : production ? 'production (set the domain; add AI keys in owner admin after bootstrap)' : 'development with explicitly labelled TEST AI'}.`,
);
