import { resolve } from 'node:path';
import { root, supervise } from './processes.ts';
supervise([
  { entry: resolve(root, 'tooling/server/run.ts'), args: ['--built', 'serve'] },
  { entry: resolve(root, 'tooling/server/run.ts'), args: ['--built', 'worker'] },
  {
    entry: resolve(root, 'client/scripts/serve.ts'),
    nodeArgs: ['--env-file-if-exists=' + resolve(root, 'client/.env')],
  },
]);
