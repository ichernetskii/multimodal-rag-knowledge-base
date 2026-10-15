import { serverPath } from '../../config/paths.js';
import { pythonCommand, visionCommand } from './health.js';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Settings } from '../../domain/entities.js';
import { AppError, requireValue } from '../../shared/errors.js';
import { parseText } from './parse-text.js';
export async function extract(
  name: string,
  bytes: Uint8Array,
  settings: Settings,
  signal: AbortSignal,
  onOCR: () => void,
): Promise<Page[]> {
  signal.throwIfAborted();
  if (extname(name).toLowerCase() !== '.pdf') {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n');
    } catch {
      throw new AppError('INVALID_ENCODING', 'Нужен документ в UTF-8.');
    }
    requireValue(
      text.length <= settings.maxTextCharacters,
      'EXTRACTED_TEXT_LIMIT',
      'Документ превышает лимит извлечённого текста. Разделите документ или измените лимит.',
    );
    const sections = await parseText(
      ['.md', '.markdown'].includes(extname(name).toLowerCase()) ? 'markdown' : 'text',
      text,
      settings.maxTextCharacters,
      signal,
    );
    requireValue(text.trim(), 'EMPTY_DOCUMENT', 'Документ пуст.');
    return [
      {
        number: 1,
        text,
        method: 'text',
        warnings: [],
        sections: sections.map((s) => ({ title: s.title, text: s.text })),
      },
    ];
  }
  requireValue(
    Buffer.from(bytes).subarray(0, 5).toString() === '%PDF-',
    'INVALID_PDF',
    'Файл не является PDF.',
  );
  const directory = await mkdtemp(join(settings.dataDir, 'extract-'));
  try {
    const path = join(directory, 'input.pdf');
    await writeFile(path, bytes, { mode: 0o600 });
    signal.throwIfAborted();
    return await new Promise<Page[]>((resolve, reject) => {
      const script =
        (process.env.PDF_EXTRACT_SCRIPT ? serverPath(process.env.PDF_EXTRACT_SCRIPT) : undefined) ??
        fileURLToPath(new URL('../../../scripts/extract-pdf.py', import.meta.url));
      const child = spawn(
        pythonCommand(),
        [
          script,
          path,
          settings.ocrLanguage,
          String(settings.maxPages),
          String(settings.ocrTimeoutSeconds),
          String(settings.maxTextCharacters),
        ],
        {
          signal,
          detached: process.platform !== 'win32',
          env: {
            ...process.env,
            ...(visionCommand() ? { OCR_VISION_BIN: visionCommand() } : {}),
            OMP_THREAD_LIMIT: '1',
            OPENBLAS_NUM_THREADS: '1',
            OCR_MEMORY_MB: String(settings.ocrMemoryMB),
          },
        },
      );
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          child.kill(signal);
        }
      };
      const abort = () => kill('SIGKILL');
      signal.addEventListener('abort', abort, { once: true });
      let parts: Buffer[] = [],
        pendingBytes = 0,
        limitError: AppError | undefined;
      let pages: Page[] | undefined;
      let size = 0;
      const timer = setTimeout(
        () => kill('SIGKILL'),
        settings.maxPages * settings.ocrTimeoutSeconds * 1000 + 60_000,
      );
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (
          size >
          Math.min(
            settings.maxBytes * 10,
            settings.maxTextCharacters * 8 + settings.maxPages * 4096,
          )
        ) {
          limitError = new AppError(
            'EXTRACTED_TEXT_LIMIT',
            'Превышен лимит извлечённого текста. Разделите документ или измените лимит.',
          );
          kill('SIGKILL');
          return;
        }
        let start = 0,
          at: number;
        while ((at = chunk.indexOf(10, start)) >= 0) {
          parts.push(chunk.subarray(start, at));
          pendingBytes += at - start;
          try {
            const item = JSON.parse(Buffer.concat(parts, pendingBytes).toString()) as {
              progress?: string;
              pages?: Page[];
              error?: string;
            };
            if (item.error) {
              limitError = new AppError(
                item.error === 'PAGE_LIMIT' ? 'PAGE_LIMIT' : 'EXTRACTED_TEXT_LIMIT',
                item.error === 'PAGE_LIMIT'
                  ? 'Превышен лимит страниц PDF.'
                  : 'Превышен лимит извлечённого текста.',
              );
            }
            if (item.progress === 'ocr') onOCR();
            if (item.pages) {
              requireValue(
                item.pages.reduce((total, page) => total + page.text.length, 0) <=
                  settings.maxTextCharacters,
                'EXTRACTED_TEXT_LIMIT',
                'Документ превышает лимит извлечённого текста.',
              );
              pages = item.pages;
            }
          } catch (error) {
            limitError = error instanceof AppError ? error : undefined;
            kill('SIGKILL');
          }
          parts = [];
          pendingBytes = 0;
          start = at + 1;
        }
        if (start < chunk.length) {
          parts.push(chunk.subarray(start));
          pendingBytes += chunk.length - start;
        }
      });
      // stderr is intentionally not logged: parsers can echo document text.
      child.stderr.resume();
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (limitError) reject(limitError);
        else if (code === 0 && pages) resolve(pages);
        else
          reject(
            new AppError(
              'PDF_EXTRACTION_FAILED',
              'Не удалось обработать PDF. Проверьте PDF_PYTHON, pdfplumber, pypdfium2 и tesseract.',
            ),
          );
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
