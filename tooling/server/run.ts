import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2),
  watch = args.includes('--watch'),
  built = args.includes('--built');
const filtered = args.filter((v) => !['--watch', '--built'].includes(v));
const child = spawn(
  process.execPath,
  [
    ...(watch ? ['--watch'] : []),
    ...(!built ? ['--import', 'tsx'] : []),
    fileURLToPath(
      new URL(
        built
          ? '../../server/dist/interfaces/cli/main.js'
          : '../../server/src/interfaces/cli/main.ts',
        import.meta.url,
      ),
    ),
    ...filtered,
  ],
  { stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => child.kill(signal));
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
