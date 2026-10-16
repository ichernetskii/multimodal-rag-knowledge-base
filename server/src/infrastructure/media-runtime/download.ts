import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DownloadAsset } from './manifest.js';
export async function digestFile(path: string) {
  const digest = createHash('sha256');
  for await (const part of createReadStream(path) as AsyncIterable<Buffer>) digest.update(part);
  return digest.digest('hex');
}
export async function matchesAsset(path: string, asset: DownloadAsset) {
  try {
    const info = await stat(path);
    return (
      info.isFile() &&
      info.size > 0 &&
      info.size <= asset.maxBytes &&
      (await digestFile(path)) === asset.sha256
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export async function downloadVerified(
  path: string,
  asset: DownloadAsset,
  options: { offline?: boolean; signal?: AbortSignal } = {},
) {
  if (await matchesAsset(path, asset)) return false;
  if (options.offline)
    throw new Error(
      `Файл отсутствует или повреждён: ${path}. Выполните yarn prepare:media с доступом к сети.`,
    );
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  const response = await fetch(asset.url, {
    signal: AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(600_000),
    ]),
  });
  if (!response.ok || !response.body)
    throw new Error(`Не удалось скачать ${asset.url}: HTTP ${response.status}`);
  const reader = response.body.getReader(),
    file = await open(temporary, 'wx', 0o600),
    digest = createHash('sha256');
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > asset.maxBytes)
        throw new Error('Скачиваемый файл превышает закреплённый лимит размера.');
      digest.update(part.value);
      let offset = 0;
      while (offset < part.value.byteLength) {
        const result = await file.write(part.value, offset, part.value.byteLength - offset);
        if (!result.bytesWritten) throw new Error('Не удалось записать скачиваемый файл.');
        offset += result.bytesWritten;
      }
    }
    if (!bytes || digest.digest('hex') !== asset.sha256)
      throw new Error('Контрольная сумма скачанного файла не совпала.');
    await file.sync();
    await file.close();
    await rename(temporary, path);
    return true;
  } finally {
    await reader.cancel().catch(() => {});
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}
