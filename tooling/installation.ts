/** Offline operator snapshot: PostgreSQL dump + stopped local S3 filesystem. No host pg_dump required. */
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { schemaSignature } from '../server/src/infrastructure/database/postgres-schema.ts';
const [command, destination] = process.argv.slice(2);
if (!['backup', 'restore'].includes(command ?? '') || !destination)
  throw new Error(
    'Usage: yarn installation:backup <new-directory> | yarn installation:restore <directory> --confirm-replace-installation',
  );
const project = process.env.INSTALLATION_PROJECT ?? 'local-rag-saas-app';
if (!/^[a-z0-9][a-z0-9-]+$/u.test(project)) throw new Error('Invalid project name');
const directory = resolve(destination);
const docker = process.env.DOCKER_BIN ?? 'docker';
const base = ['compose', '--env-file', '.env', '-p', project, '--profile', 'app'];
async function run(args: string[], input?: string, output?: string) {
  const child = spawn(docker, args, {
    stdio: [input ? 'pipe' : 'ignore', output ? 'pipe' : 'inherit', 'inherit'],
  });
  const streams: Promise<void>[] = [];
  if (input) streams.push(pipeline(createReadStream(input), child.stdin!));
  if (output)
    streams.push(pipeline(child.stdout!, createWriteStream(output, { flags: 'wx', mode: 0o600 })));
  await Promise.all([
    ...streams,
    new Promise<void>((r, j) => {
      child.once('error', j);
      child.once('exit', (code) => (code === 0 ? r() : j(new Error('Docker failed: ' + code))));
    }),
  ]);
}
async function sha(file: string) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(resolve(directory, file))) h.update(chunk as Buffer);
  return h.digest('hex');
}
const apps = ['api', 'worker-answers', 'worker-indexing', 'worker-maintenance', 'worker-quality'];
if (command === 'backup') await mkdir(directory, { mode: 0o700 });
else {
  if (!process.argv.includes('--confirm-replace-installation'))
    throw new Error(
      'Restore replaces the selected installation. Add --confirm-replace-installation.',
    );
  const meta = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8')) as {
    format: string;
    files: Record<string, string>;
  };
  if (meta.format !== schemaSignature) throw new Error('Incompatible installation snapshot');
  for (const name of ['postgres.dump', 'storage.tar'])
    if ((await sha(name)) !== meta.files[name])
      throw new Error('Snapshot checksum mismatch: ' + name);
}
await run([...base, 'stop', ...apps, 'storage']);
try {
  if (command === 'backup') {
    await run(
      [...base, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', '-d', 'rag', '-Fc'],
      undefined,
      resolve(directory, 'postgres.dump'),
    );
    await run(
      [
        'run',
        '--rm',
        '--network',
        'none',
        '-v',
        project + '_storage-data:/data:ro',
        'alpine:3.23',
        'tar',
        '-cf',
        '-',
        '-C',
        '/data',
        '.',
      ],
      undefined,
      resolve(directory, 'storage.tar'),
    );
    await writeFile(
      resolve(directory, 'manifest.json'),
      JSON.stringify(
        {
          format: schemaSignature,
          created: new Date().toISOString(),
          files: {
            'postgres.dump': await sha('postgres.dump'),
            'storage.tar': await sha('storage.tar'),
          },
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    console.log(
      'Snapshot saved. Store the private .env separately and protect both the snapshot and secrets.',
    );
  } else {
    await run([
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      project + '_storage-data:/data',
      'alpine:3.23',
      'sh',
      '-c',
      'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +',
    ]);
    await run(
      [
        'run',
        '--rm',
        '-i',
        '--network',
        'none',
        '-v',
        project + '_storage-data:/data',
        'alpine:3.23',
        'tar',
        '-xf',
        '-',
        '-C',
        '/data',
      ],
      resolve(directory, 'storage.tar'),
    );
    await run([
      ...base,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'rag',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'DROP SCHEMA IF EXISTS pgboss CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;',
    ]);
    await run(
      [
        ...base,
        'exec',
        '-T',
        'postgres',
        'pg_restore',
        '-U',
        'postgres',
        '-d',
        'rag',
        '--exit-on-error',
      ],
      resolve(directory, 'postgres.dump'),
    );
    await run([...base, 'run', '--rm', 'init']);
    console.log('Installation restored. In-flight AI requests require review before retrying.');
  }
} finally {
  await run([...base, 'start', 'storage', ...apps]);
}
if (command === 'backup' && (await readdir(directory)).length !== 3)
  throw new Error('Unexpected snapshot contents');
