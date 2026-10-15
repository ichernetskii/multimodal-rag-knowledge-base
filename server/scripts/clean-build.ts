import { rmSync } from 'node:fs';
// Compiler output must not retain modules deleted or moved in source.
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
