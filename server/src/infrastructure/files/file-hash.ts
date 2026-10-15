import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
/** Hash large backups without allocating a buffer equal to the entire database. */
export async function fileHash(path: string) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path, { highWaterMark: 1024 * 1024 }))
    digest.update(bytes as Buffer);
  return digest.digest('hex');
}
