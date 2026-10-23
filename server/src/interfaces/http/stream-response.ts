import type { ServerResponse } from 'node:http';
import { AppError } from '../../shared/errors.js';
/** Bounded backpressure with cancellation; a disconnected client cannot pin a DB snapshot. */
export async function writeChunk(
  res: ServerResponse,
  value: string | Uint8Array,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (res.destroyed) throw new AppError('CLIENT_DISCONNECTED', 'Connection closed.', 499);
  if (res.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
        clearTimeout(timer);
        res.off('drain', drain);
        res.off('close', close);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      },
      drain = () => finish(),
      close = () => finish(new AppError('CLIENT_DISCONNECTED', 'Connection closed.', 499)),
      abort = () =>
        finish(
          signal.reason instanceof Error
            ? signal.reason
            : new AppError('DOWNLOAD_CANCELLED', 'Download cancelled.', 499),
        ),
      timer = setTimeout(
        () =>
          finish(new AppError('CLIENT_TIMEOUT', 'The client is receiving data too slowly.', 408)),
        15000,
      );
    res.once('drain', drain);
    res.once('close', close);
    signal.addEventListener('abort', abort, { once: true });
  });
}
