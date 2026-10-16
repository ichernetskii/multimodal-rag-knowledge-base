import { watch } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, supervise } from './processes.ts';
const generate = () => {
  const result = spawnSync(process.execPath, [resolve(root, 'tooling/contracts.ts')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('Contract generation failed');
};
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(resolve(root, '.env'));
  } catch {
    throw new Error('Run yarn configure and yarn infra:up first.');
  }
}
generate();
let timer: ReturnType<typeof setTimeout> | undefined;
const contracts = watch(resolve(root, 'server/src/contracts'), { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(generate, 100);
});
const processes = supervise([
  { entry: resolve(root, 'tooling/server/run.ts'), args: ['--watch', 'serve'] },
  { entry: resolve(root, 'tooling/server/run.ts'), args: ['--watch', 'worker'] },
  { entry: resolve(root, 'node_modules/vite/bin/vite.js'), cwd: resolve(root, 'client') },
]);
for (const child of processes.children)
  child.once('exit', () => {
    clearTimeout(timer);
    contracts.close();
  });
