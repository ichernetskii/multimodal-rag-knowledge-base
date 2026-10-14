import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDocumentLoader } from '../src/documents/file-loader.js';
import { TextDocumentParser } from '../src/documents/parser.js';
import { TokenDocumentChunker } from '../src/chunking/token-chunker.js';
import { EmbeddingGemmaFormatter } from '../src/embeddings/formatter.js';
import { loadConfig } from '../src/config.js';
import { loadRuntimeConfig } from '../src/runtime-config.js';
import { document, wordTokenizer } from './helpers.js';

const parser = new TextDocumentParser();
const formatter = new EmbeddingGemmaFormatter(loadRuntimeConfig({}).embedding);

void test('Formatting does not replace placeholders contained in the title', () => {
  assert.equal(
    formatter.document('{text}.md', 'Section', 'Body'),
    'title: {text}.md — Section | text: Body',
  );
});

void test('Markdown preserves heading hierarchy and ignores headings inside code blocks', () => {
  const sections = parser.parse(
    document('# Policy\n\n## Leave\n\nText.\n\n```js\n# this is code\n```\n\n## IT\n\nOther text.'),
  );
  assert.equal(sections.length, 2);
  assert.equal(sections[0]?.title, 'Policy → Leave');
  assert.match(sections[0]?.text ?? '', /# this is code/u);
  assert.equal(sections[1]?.title, 'Policy → IT');
});

void test('Introductions and Setext headings are preserved; TXT is treated as plain text', () => {
  assert.deepEqual(
    parser
      .parse(document('Introduction.\n\nPolicy\n=======\n\nMain text.'))
      .map((section) => section.title),
    ['Introduction', 'Policy'],
  );
  const sections = parser.parse(document('# Literal text\n\nBody', 'text'));
  assert.equal(sections.length, 1);
  assert.match(sections[0]?.text ?? '', /^# Literal/u);
});

void test('Chunking includes the prefix, preserves content, and keeps sections separate', async () => {
  const text = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
  const source = document(`# A\n\n## Leave\n\n${text}\n\n## IT\n\nitMarker`);
  const chunker = new TokenDocumentChunker(
    wordTokenizer,
    formatter,
    { targetTokens: 32, overlapTokens: 4, maxCharacters: 4096 },
    40,
  );
  const chunks = await chunker.chunk(source, parser.parse(source));
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((item) => item.tokenCount <= 32));
  assert.ok(
    chunks
      .filter((item) => item.section.includes('Leave'))
      .every((item) => !item.body.includes('itMarker')),
  );
  for (let i = 0; i < 100; i++) assert.ok(chunks.some((item) => item.body.includes(`word${i}`)));
  assert.ok(chunks.every((item) => item.embeddingInput.startsWith('title: test.md —')));
});

void test('Empty documents and long titles produce clear errors', async () => {
  const chunker = new TokenDocumentChunker(
    wordTokenizer,
    formatter,
    { targetTokens: 32, overlapTokens: 4, maxCharacters: 4096 },
    40,
  );
  await assert.rejects(chunker.chunk(document(''), []), /no content/u);
  const source = document(`# ${'very '.repeat(40)}\n\nText`);
  await assert.rejects(
    chunker.chunk(source, parser.parse(source)),
    /The section title is too long/u,
  );
});

void test('The loader detects formats, normalizes text, and checks extension and size', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'rag-loader-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'example.txt');
  await writeFile(path, '\uFEFFLine\r\nSecond line');
  const loaded = await new FileDocumentLoader(1024).load(path);
  assert.equal(loaded.format, 'text');
  assert.equal(loaded.text, 'Line\nSecond line');
  await assert.rejects(new FileDocumentLoader(1).load(path), /size/u);
  const unsupported = join(directory, 'example.pdf');
  await writeFile(unsupported, 'text');
  await assert.rejects(new FileDocumentLoader(1024).load(unsupported), /Supported/u);
});

void test('General configuration rejects invalid limits and thresholds', () => {
  assert.throws(() => loadConfig({ CHUNK_TOKENS: '0' }), /CHUNK_TOKENS/u);
  assert.throws(() => loadConfig({ CHUNK_OVERLAP: '999' }), /CHUNK_OVERLAP/u);
  assert.throws(() => loadConfig({ SCORE_THRESHOLD: 'NaN' }), /SCORE_THRESHOLD/u);
});
