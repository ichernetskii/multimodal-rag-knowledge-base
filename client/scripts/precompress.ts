import { readdir, readFile, writeFile } from 'node:fs/promises';
import { brotliCompress, gzip, constants } from 'node:zlib';
import { promisify } from 'node:util';
const br = promisify(brotliCompress),
  gz = promisify(gzip);
async function walk(directory: URL): Promise<void> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = new URL(item.name + (item.isDirectory() ? '/' : ''), directory);
    if (item.isDirectory()) await walk(file);
    else if (/\.(?:js|css|svg|html)$/u.test(item.name)) {
      const input = await readFile(file);
      if (input.byteLength < 512) continue;
      await writeFile(
        new URL(file.href + '.br'),
        await br(input, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }),
      );
      await writeFile(new URL(file.href + '.gz'), await gz(input, { level: 9 }));
    }
  }
}
await walk(new URL('../dist/', import.meta.url));
