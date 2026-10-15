/** Large Markdown parsing runs outside the API event loop with a bounded V8 heap. */
import { TextDocumentParser } from './text-parser.js';
import { errorResponse, requireValue } from '../../shared/errors.js';
try {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of process.stdin) {
    const bytes = part as Buffer;
    size += bytes.byteLength;
    requireValue(size <= 128 * 1024 * 1024, 'TEXT_PARSE_LIMIT', 'Превышен лимит разбора текста.');
    parts.push(bytes);
  }
  const input = JSON.parse(Buffer.concat(parts, size).toString()) as {
    text: string;
    maxCharacters: number;
  };
  const sections = new TextDocumentParser(input.maxCharacters).parse({
    format: 'markdown',
    text: input.text,
  });
  process.stdout.write(JSON.stringify({ sections }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: errorResponse(error).error }));
  process.exitCode = 1;
}
