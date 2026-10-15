import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
export const serverPath = (value: string) => resolve(serverRoot, value);

export const serverExecutable = (value: string) =>
  value.includes('/') || value.startsWith('.') ? serverPath(value) : value;
