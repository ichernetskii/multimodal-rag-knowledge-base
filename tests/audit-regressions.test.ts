import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { Ollama } from 'ollama';
import { SqliteVectorStore } from '../src/storage/sqlite-store.js';
import { TextDocumentParser } from '../src/documents/parser.js';
import { TokenDocumentChunker } from '../src/chunking/token-chunker.js';
import { EmbeddingGemmaFormatter } from '../src/embeddings/formatter.js';
import { OllamaAnswerGenerator } from '../src/generation/ollama-generator.js';
import { loadConfig } from '../src/config.js';
import { loadRuntimeConfig } from '../src/runtime-config.js';
import { hash } from '../src/core/hash.js';
import { RagService } from '../src/core/rag-service.js';
import type { RagStages } from '../src/core/rag-service.js';
import { document, testTokenizer } from './helpers.js';

void test('Rejecting an unrelated SQLite database leaves every byte unchanged', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'rag-foreign-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'foreign.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE important(value TEXT)');
  db.close();
  const before = hash(await readFile(path));
  assert.throws(
    () => new SqliteVectorStore(path, { dimensions: 3, signature: 'test' }),
    /another database/u,
  );
  assert.equal(hash(await readFile(path)), before);
});

void test('Opening an existing file without create does not initialize a schema', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'rag-empty-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'empty.sqlite');
  new DatabaseSync(path).close();
  assert.throws(
    () => new SqliteVectorStore(path, { dimensions: 3, signature: 'test', create: false }),
    /ready RAG index/u,
  );
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 0);
  } finally {
    db.close();
  }
});

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

void test('A truncated LLM answer is rejected', async () => {
  const config = loadRuntimeConfig({});
  const client = new Ollama({
    fetch: async () =>
      new Response(
        JSON.stringify({ done_reason: 'length', message: { content: 'Partial answer' } }),
      ),
  });
  await assert.rejects(
    new OllamaAnswerGenerator(client, config.llm, '5m').generate({ messages: [], sources: [] }),
    /truncated/u,
  );
});

void test('CLI help works with invalid configuration', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', '--help'],
    { env: { ...process.env, OLLAMA_URL: 'invalid', EMBEDDING_MAX_TOKENS: '32768' } },
  );
  assert.match(stdout, /yarn ingest/u);
});

void test('RAG awaits asynchronous storage cleanup', async () => {
  let closed = false;
  const stages = {
    embedder: { close: async () => {} },
    store: {
      close: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        closed = true;
      },
    },
  } as unknown as RagStages;
  const service = new RagService(stages, 1);
  await service.close();
  assert.equal(closed, true);
  assert.throws(() => new RagService(stages, 0), /Batch size/u);
});
