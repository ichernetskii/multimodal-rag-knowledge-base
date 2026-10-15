import { spawn } from 'node:child_process';
import type { FSWatcher } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { watch as watchFiles } from 'node:fs';

// Runtime data/cache paths belong to server/. CLI file arguments resolve from the repository.
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = resolve(root, 'server');
const args = process.argv.slice(2);
const built = args[0] === '--built';
if (built) args.shift();
const watch = args[0] === '--watch';
if (watch) args.shift();
const script = args[0] === '--script';
if (script) args.shift();
const entry = script
  ? resolve(root, 'server/scripts', args.shift()!)
  : resolve(
      root,
      built ? 'server/dist/interfaces/cli/main.js' : 'server/src/interfaces/cli/main.ts',
    );
const childArgs = [
  '--env-file-if-exists=' + resolve(server, '.env'),
  ...(built ? [] : ['--import', 'tsx']),
  entry,
  ...args,
];
let closing = false,
  restarting = false,
  changed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
const watchers: FSWatcher[] = [];
function stopWatchers() {
  clearTimeout(timer);
  for (const watcher of watchers) watcher.close();
}
function start() {
  const processChild = spawn(process.execPath, childArgs, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  processChild.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
    stopWatchers();
  });
  processChild.once('exit', (code, signal) => {
    if (!restarting) {
      if (watch && !closing) {
        console.error('Server stopped. Waiting for a source or configuration change.');
      } else {
        process.exitCode = closing ? 0 : (code ?? (signal ? 1 : 0));
        stopWatchers();
      }
    }
  });
  return processChild;
}
let child = start();
async function restart() {
  if (closing) return;
  if (restarting) {
    changed = true;
    return;
  }
  restarting = true;
  do {
    changed = false;
    console.log('Server source changed; waiting for shutdown before restart.');
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((done) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
        timer.unref();
        child.once('exit', () => {
          clearTimeout(timer);
          done();
        });
        child.kill('SIGTERM');
      });
    if (!closing) child = start();
  } while (changed && !closing);
  restarting = false;
}
function scheduleRestart() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    void restart();
  }, 200);
}
if (watch) {
  watchers.push(watchFiles(resolve(root, 'server/src'), { recursive: true }, scheduleRestart));
  watchers.push(
    watchFiles(server, (_event, filename) => {
      if (filename === '.env') scheduleRestart();
    }),
  );
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    stopWatchers();
    child.kill('SIGTERM');
  });
