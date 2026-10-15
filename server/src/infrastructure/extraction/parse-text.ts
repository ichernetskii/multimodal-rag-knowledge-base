import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { DocumentSection } from '../../application/ports/embedding.js';
import { AppError } from '../../shared/errors.js';
import { TextDocumentParser } from './text-parser.js';
export async function parseText(
  format: 'text' | 'markdown',
  text: string,
  maxCharacters: number,
  signal: AbortSignal,
): Promise<DocumentSection[]> {
  signal.throwIfAborted();
  if (format === 'text' || text.length <= 256 * 1024)
    return new TextDocumentParser(maxCharacters).parse({ format, text });
  return new Promise((resolve, reject) => {
    const typescript = import.meta.url.endsWith('.ts'),
      entry = fileURLToPath(
        new URL(typescript ? './text-worker.ts' : './text-worker.js', import.meta.url),
      ),
      child = spawn(
        process.execPath,
        ['--max-old-space-size=256', ...(typescript ? ['--import', 'tsx'] : []), entry],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      ),
      parts: Buffer[] = [];
    let size = 0,
      error: AppError | undefined;
    const abort = () => child.kill('SIGKILL'),
      timer = setTimeout(() => {
        error = new AppError(
          'TEXT_PARSE_TIMEOUT',
          'Превышен лимит времени разбора Markdown. Разделите документ.',
        );
        child.kill('SIGKILL');
      }, 30000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', (bytes: Buffer) => {
      size += bytes.length;
      if (size > Math.min(128 * 1024 * 1024, maxCharacters * 8 + 65536)) {
        error = new AppError(
          'TEXT_PARSE_LIMIT',
          'Результат разбора текста превышает лимит. Разделите документ.',
        );
        child.kill('SIGKILL');
      } else parts.push(bytes);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', (cause) => {
      error = new AppError('TEXT_PARSE_FAILED', cause.message, 500);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException('Text parsing cancelled', 'AbortError'),
        );
        return;
      }
      if (error) {
        reject(error);
        return;
      }
      try {
        const result = JSON.parse(Buffer.concat(parts, size).toString()) as {
          sections?: DocumentSection[];
          error?: { code: string; message: string };
        };
        if (result.error) throw new AppError(result.error.code, result.error.message);
        if (code !== 0 || !result.sections) throw new Error('Parser stopped');
        resolve(result.sections);
      } catch (cause) {
        reject(
          cause instanceof AppError
            ? cause
            : new AppError(
                'TEXT_PARSE_LIMIT',
                'Не удалось разобрать Markdown в пределах ресурсов. Разделите документ.',
              ),
        );
      }
    });
    child.stdin.end(JSON.stringify({ text, maxCharacters }));
  });
}
