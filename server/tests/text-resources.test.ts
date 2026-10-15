import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseText } from '../src/infrastructure/extraction/parse-text.js';
import { TextDocumentParser } from '../src/infrastructure/extraction/text-parser.js';
import { TokenDocumentChunker } from '../src/infrastructure/indexing/token-chunker.js';
import { defaults } from '../src/config/default-settings.js';
import { extract } from '../src/infrastructure/extraction/extract.js';
import { wordTokenizer } from './helpers.js';
const formatter = {
  signature: 'test',
  document: (_name: string, _section: string, body: string) => body,
  query: (question: string) => question,
};
void test('large Markdown parsing preserves sections without monopolizing the server event loop', async () => {
  const text =
      '# First section\n\n' +
      'A useful paragraph with a reference.\n\n'.repeat(10000) +
      '\n# Second section\n\nFinal content.',
    ticks: { count: number } = { count: 0 };
  const timer = setInterval(() => ticks.count++, 5);
  try {
    const sections = await parseText('markdown', text, 1_000_000, new AbortController().signal);
    assert.equal(sections.length, 2);
    assert.equal(sections[0]?.title, 'First section');
    assert.equal(sections[1]?.text, 'Final content.');
    assert.ok(ticks.count > 1, 'API timers must continue while Markdown is parsed');
  } finally {
    clearInterval(timer);
  }
});
void test('large text extraction can be cancelled while its parser process is working', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'rag-large-text-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 40);
  try {
    await assert.rejects(
      extract(
        'large.md',
        Buffer.from('# Section\n\nParagraph.\n\n'.repeat(30000)),
        defaults(path, 'test', 'test'),
        controller.signal,
        () => {},
      ),
      (error) =>
        error instanceof Error && (error.name === 'AbortError' || controller.signal.aborted),
    );
  } finally {
    clearTimeout(timer);
  }
});
void test('reference expansion is bounded by extracted-text policy', () => {
  const text =
    '# One\n\nSee [guide].\n\n# Two\n\nSee [guide].\n\n[guide]: https://example.test/' +
    'x'.repeat(160);
  assert.throws(
    () => new TextDocumentParser(text.length + 1).parse({ format: 'markdown', text }),
    (error) => error instanceof Error && 'code' in error && error.code === 'EXTRACTED_TEXT_LIMIT',
  );
});
void test('chunking yields during a large section and enforces cancellation before inference', async () => {
  const controller = new AbortController(),
    chunker = new TokenDocumentChunker(
      wordTokenizer,
      formatter,
      { targetTokens: 24, overlapTokens: 2, maxCharacters: 1000 },
      256,
    ),
    timer = setTimeout(() => controller.abort(), 1),
    text = 'word '.repeat(100000);
  try {
    await assert.rejects(
      chunker.chunk(
        { name: 'large.txt', format: 'text', text },
        [{ title: 'Text', text, startLine: 1, endLine: 1 }],
        { signal: controller.signal, maxChunks: 1000 },
      ),
      (error) => error instanceof Error && error.name === 'AbortError',
    );
  } finally {
    clearTimeout(timer);
  }
});
void test('fragment limits stop tokenization before building an oversized embedding batch', async () => {
  const text = 'word '.repeat(1000),
    chunker = new TokenDocumentChunker(
      wordTokenizer,
      formatter,
      { targetTokens: 24, overlapTokens: 2, maxCharacters: 1000 },
      256,
    );
  await assert.rejects(
    chunker.chunk(
      { name: 'test.txt', format: 'text', text },
      [{ title: 'Text', text, startLine: 1, endLine: 1 }],
      { maxChunks: 2 },
    ),
    (error) => error instanceof Error && 'code' in error && error.code === 'CHUNK_LIMIT',
  );
});
