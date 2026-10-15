import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from './processes.ts';
for (const file of ['server/.env', 'client/.env', 'compose.env']) {
  const target = resolve(root, file);
  if (!existsSync(target)) {
    copyFileSync(resolve(root, file + '.example'), target);
    console.log(file + ' created');
  } else console.log(file + ' exists; preserved');
}
mkdirSync(resolve(root, 'server/data'), { recursive: true, mode: 0o700 });
mkdirSync(resolve(root, 'server/.cache'), { recursive: true, mode: 0o700 });
