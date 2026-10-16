import { spawn } from 'node:child_process';
import { serverExecutable } from '../../config/paths.js';
import { managedMediaCommand, mediaRuntimeDirectory } from '../../config/media-runtime.js';
import { AppError } from '../../shared/errors.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mediaBuildVersion } from '../media-runtime/manifest.js';
export function mediaCommand(name: 'ffmpeg' | 'ffprobe' | 'whisper') {
  const custom =
    process.env[{ ffmpeg: 'FFMPEG_BIN', ffprobe: 'FFPROBE_BIN', whisper: 'WHISPER_BIN' }[name]];
  if (custom) return serverExecutable(custom);
  let receipt: { version?: string; platform?: string; arch?: string };
  try {
    receipt = JSON.parse(
      readFileSync(join(mediaRuntimeDirectory(), 'receipt.json'), 'utf8'),
    ) as typeof receipt;
  } catch {
    throw new AppError(
      'MEDIA_TOOL_UNAVAILABLE',
      'Медиатулы не установлены. Выполните yarn prepare:media или пересоберите серверный Docker-образ.',
      503,
    );
  }
  if (
    receipt.version !== mediaBuildVersion ||
    receipt.platform !== process.platform ||
    receipt.arch !== process.arch
  )
    throw new AppError(
      'MEDIA_RUNTIME_OUTDATED',
      'Версия медиатулов не соответствует приложению. Выполните yarn prepare:media или пересоберите серверный Docker-образ.',
      503,
    );
  return managedMediaCommand(name);
}

/** No shell; bounded pipes, deadline and immediate process termination on cancellation. */
export function mediaProcess(
  command: string,
  args: string[],
  signal: AbortSignal,
  limit = 2_000_000,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' },
    });
    const parts: Buffer[] = [];
    let size = 0,
      exceeded = false;
    const abort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (part: Buffer) => {
      size += part.length;
      if (size > limit) {
        exceeded = true;
        child.kill('SIGKILL');
      } else parts.push(part);
    });
    // Decoder logs can contain document contents; never return them to another user.
    child.stderr.on('data', () => {});
    child.once('error', () => {
      signal.removeEventListener('abort', abort);
      reject(
        new AppError(
          'MEDIA_TOOL_UNAVAILABLE',
          'Не удалось запустить FFmpeg/whisper.cpp. Проверьте диагностику сервера.',
          503,
        ),
      );
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted)
        reject(
          new AppError(
            'MEDIA_CANCELLED_OR_TIMEOUT',
            'Обработка медиа отменена или превысила лимит времени.',
          ),
        );
      else if (exceeded)
        reject(new AppError('MEDIA_OUTPUT_LIMIT', 'Превышен лимит вывода обработчика медиа.'));
      else if (code !== 0)
        reject(
          new AppError(
            'MEDIA_DECODE_FAILED',
            'Не удалось прочитать медиа или выполнить расшифровку. Проверьте формат файла, модель Whisper и язык.',
          ),
        );
      else resolve(Buffer.concat(parts).toString('utf8'));
    });
  });
}
