import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(new URL('../.env', import.meta.url)))
  process.loadEnvFile(new URL('../.env', import.meta.url));
const docker =
  process.env.DOCKER_BIN ||
  (existsSync('/Users/' + process.env.USER + '/.docker/bin/docker')
    ? '/Users/' + process.env.USER + '/.docker/bin/docker'
    : 'docker');
const command = process.argv[2] ?? 'up';
export async function run(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(docker, args, {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        PATH: process.env.PATH + ':/Applications/Docker.app/Contents/Resources/bin',
      },
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Docker command failed: ' + code)),
    );
  });
}
const base = [
  'compose',
  '--env-file',
  '.env',
  '-f',
  'compose.yaml',
  '-f',
  'compose.dev.yaml',
  '-p',
  'local-rag-saas-dev',
];
if (!existsSync(new URL('../.env', import.meta.url))) throw new Error('Run yarn configure first.');
if (command === 'up') await run([...base, 'up', '-d', '--wait', 'postgres', 'redis', 'storage']);
else if (command === 'down') await run([...base, 'down']);
else if (command === 'reset') {
  if (!process.argv.includes('--confirm-development-reset'))
    throw new Error(
      'This deletes ONLY the local-rag-saas-dev Docker volumes. Run yarn dev:reset --confirm-development-reset to confirm.',
    );
  await run([...base, 'down', '--volumes']);
  await run([...base, 'up', '-d', '--wait', 'postgres', 'redis', 'storage']);
} else if (command === 'app' || command === 'app-down')
  await run([
    'compose',
    '--env-file',
    '.env',
    '-f',
    'compose.yaml',
    ...(process.env.LOCAL_AI === '1' ? ['-f', 'compose.local-ai.yaml'] : []),
    '-p',
    'local-rag-saas-app',
    '--profile',
    'app',
    ...(command === 'app' ? ['up', '-d', '--build', '--wait', '--wait-timeout', '3600'] : ['down']),
  ]);
else throw new Error('Unknown infrastructure command.');
