import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config/app-config.js';
import { loadRuntimeConfig } from '../src/config/runtime-config.js';
import { TextDocumentParser } from '../src/infrastructure/extraction/text-parser.js';
import { TokenDocumentChunker } from '../src/infrastructure/indexing/token-chunker.js';
import { EmbeddingGemmaFormatter } from '../src/infrastructure/models/embedding-formatter.js';
import { document, testTokenizer } from './helpers.js';

void test('Markdown references retain definitions from other sections', () => {
  const sections = new TextDocumentParser().parse(
    document(
      '# Section\n\nSee the [policy][policy].\n\n## Other\n\nOther information.\n\n[policy]: https://example.com/policy\n[unused]: https://example.com/other',
    ),
  );
  assert.ok(sections[0]?.text.includes('[policy]: https://example.com/policy'));
  assert.ok(
    sections.some((section) => section.text.includes('[unused]: https://example.com/other')),
  );
});

void test('Chunking preserves whole Unicode graphemes and content without whitespace', async () => {
  const text = '😀👩🏽‍💻e\u0301'.repeat(80);
  const source = document(text, 'text');
  const runtime = loadRuntimeConfig({});
  const counter = testTokenizer((value) => Array.from(value).length);
  const chunker = new TokenDocumentChunker(
    counter,
    new EmbeddingGemmaFormatter(runtime.embedding),
    { targetTokens: 64, overlapTokens: 0, maxCharacters: 4096 },
    2040,
  );
  const chunks = await chunker.chunk(source, new TextDocumentParser().parse(source));
  assert.equal(chunks.map((chunk) => chunk.body).join(''), text);
  assert.ok(chunks.every((chunk) => !/[\uD800-\uDFFF]/u.test(chunk.body)));
  const ends = new Set<number>();
  for (const item of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text))
    ends.add(item.index + item.segment.length);
  let offset = 0;
  for (const chunk of chunks) {
    offset += chunk.body.length;
    assert.ok(ends.has(offset));
    assert.ok(chunk.tokenCount <= 64);
  }
});

void test('Chunking does not assume additive token counts', async () => {
  const runtime = loadRuntimeConfig({});
  const source = document('one two three four five. '.repeat(80), 'text');
  const counter = testTokenizer((text) => Math.ceil(text.length / 3) + 1);
  const chunks = await new TokenDocumentChunker(
    counter,
    new EmbeddingGemmaFormatter(runtime.embedding),
    { targetTokens: 32, overlapTokens: 4, maxCharacters: 4096 },
    2040,
  ).chunk(source, new TextDocumentParser().parse(source));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => counter.encode(chunk.embeddingInput).tokenIds.length <= 32));
});

void test('The profile enforces EmbeddingGemma context and dimension limits', () => {
  assert.throws(
    () => loadRuntimeConfig({ EMBEDDING_MAX_TOKENS: '32768' }),
    /EMBEDDING_MAX_TOKENS/u,
  );
  assert.throws(() => loadRuntimeConfig({ EMBEDDING_DIMENSIONS: '8192' }), /EMBEDDING_DIMENSIONS/u);
  assert.ok(!('tokenizer' in loadConfig({})));
  assert.ok(!('ollama' in loadConfig({})));
});

void test('CLI help works with invalid configuration', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', 'src/interfaces/cli/main.ts', '--help'],
    { env: { ...process.env, OLLAMA_URL: 'invalid', EMBEDDING_MAX_TOKENS: '32768' } },
  );
  assert.match(stdout, /upload <file> <collection>/u);
});
