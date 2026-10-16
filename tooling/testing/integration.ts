import { spawn } from 'node:child_process';
import { isolatedDatabase } from './isolated-database.ts';
await isolatedDatabase(async (_app, config) => {
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--test',
        '--test-timeout=300000',
        'server/tests/saas.integration.test.ts',
      ],
      {
        cwd: new URL('../../', import.meta.url),
        stdio: 'inherit',
        env: {
          ...process.env,
          DATABASE_URL: config.databaseUrl,
          DATABASE_ADMIN_URL: config.adminDatabaseUrl,
          S3_BUCKET: config.storage.bucket,
          NODE_ENV: 'test',
          ALLOW_TEST_AI: '1',
          RUN_INTEGRATION: '1',
          DEFAULT_GENERATION_PROVIDER: 'test',
          DEFAULT_EMBEDDING_PROVIDER: 'test',
          DEFAULT_TRANSCRIPTION_PROVIDER: '',
        },
      },
    );
    child.once('error', reject);
    child.once('exit', resolve);
  });
  process.exitCode = code ?? 1;
});
console.log('Изолированная тестовая база и её файлы удалены.');
