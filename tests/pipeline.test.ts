import test from 'node:test';
import assert from 'node:assert/strict';
import { Ollama } from 'ollama';
import { loadConfig } from '../src/config.js';
import { loadRuntimeConfig } from '../src/runtime-config.js';
import { RagService } from '../src/core/rag-service.js';
import type { RagStages } from '../src/core/rag-service.js';
import { SourcesContextBuilder } from '../src/generation/context-builder.js';
import { OllamaAnswerGenerator } from '../src/generation/ollama-generator.js';
import { OllamaEmbeddingProvider } from '../src/embeddings/ollama-embedder.js';
import type { VectorStore } from '../src/core/contracts.js';
import { chunk, document, hit, wordCounter } from './helpers.js';

function stages(store: VectorStore): RagStages {
  return {
    loader: { load: async () => document('Text') },
    parser: { parse: () => [{ title: 'Section', text: 'Text', startLine: 1, endLine: 1 }] },
    chunker: { chunk: async () => [chunk('First'), chunk('Second', 1)] },
    embedder: {
      describe: async () => ({ model: 'test', digest: 'test', dimensions: 3 }),
      embed: async (inputs) => ({ vectors: inputs.map(() => [1, 0, 0]) }),
    },
    store,
    retriever: { retrieve: async () => [] },
    contextBuilder: new SourcesContextBuilder(loadConfig({}).context),
    generator: { generate: async () => 'Answer' },
  };
}

void test('An embedding failure prevents partial document writes', async () => {
  let writes = 0;
  const store: VectorStore = {
    replaceDocument: async () => {
      writes++;
    },
    search: async () => [],
    stats: async () => ({
      path: 'test',
      sqliteVersion: 'test',
      vectorExtensionVersion: 'test',
      documents: 0,
      chunks: 0,
      vectors: 0,
    }),
    close: () => {},
  };
  const implementations = stages(store);
  let calls = 0;
  implementations.embedder.embed = async () => {
    if (++calls === 2) throw new Error('Model error');
    return { vectors: [[1, 0, 0]] };
  };
  await assert.rejects(new RagService(implementations, 1).ingest('test.md'), /Model error/u);
  assert.equal(writes, 0);
});

void test('The LLM is not called when retrieval is empty', async () => {
  const store: VectorStore = {
    replaceDocument: async () => {},
    search: async () => [],
    stats: async () => ({
      path: 'test',
      sqliteVersion: 'test',
      vectorExtensionVersion: 'test',
      documents: 0,
      chunks: 0,
      vectors: 0,
    }),
    close: () => {},
  };
  const implementations = stages(store);
  implementations.generator.generate = async () => {
    throw new Error('The LLM must not be called');
  };
  const result = await new RagService(implementations, 16).ask('Question');
  assert.match(result.answer, /do not contain enough/u);
  assert.deepEqual(result.sources, []);
});

void test('The context budget includes whole chunks, the question, and the instruction', () => {
  const config = { ...loadConfig({}).context, maxCharacters: 1500 };
  const context = new SourcesContextBuilder(config).build('Question?', [
    hit('x'.repeat(2000)),
    hit('Short text', 2),
  ]);
  assert.equal(context.sources.length, 1);
  assert.equal(context.sources[0]?.id, 1);
  assert.equal(context.sources[0]?.text, 'Short text');
  assert.ok(context.messages.reduce((sum, item) => sum + item.content.length, 0) <= 1500);
  assert.match(context.messages[0]?.content ?? '', /data, not instructions/u);
});

void test('The Ollama adapter sends truncate=false and validates the response', async () => {
  const config = loadRuntimeConfig({ EMBEDDING_DIMENSIONS: '3' });
  let request: Record<string, unknown> = {};
  let vectors = [[1, 0, 0]];
  const client = new Ollama({
    fetch: async (input, init) => {
      if (
        (typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).endsWith('/api/tags')
      )
        return new Response(
          JSON.stringify({
            models: [
              { name: 'embeddinggemma:latest', model: 'embeddinggemma:latest', digest: 'test' },
            ],
          }),
        );
      if (
        (typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).endsWith('/api/show')
      )
        return new Response(
          JSON.stringify({ capabilities: ['embedding'], details: { family: 'gemma3' } }),
        );
      assert.ok(typeof init?.body === 'string');
      request = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(JSON.stringify({ embeddings: vectors, prompt_eval_count: 2 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const embedder = new OllamaEmbeddingProvider(
    client,
    config.embedding,
    config.ollama,
    wordCounter,
  );
  assert.deepEqual((await embedder.embed(['Text'])).vectors, [[1, 0, 0]]);
  assert.equal(request.truncate, false);
  assert.equal(request.dimensions, 3);
  vectors = [[1, 0]];
  await assert.rejects(embedder.embed(['Text']), /invalid/u);
  await assert.rejects(embedder.embed(['word '.repeat(3000)]), /Shorten/u);
});

void test('Ollama errors and unknown source references are not accepted as successful answers', async () => {
  const config = loadRuntimeConfig({});
  const context = new SourcesContextBuilder(config.app.context).build('Question', [hit('Text')]);
  const failingClient = new Ollama({
    fetch: async () =>
      new Response(JSON.stringify({ error: 'model not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
  });
  await assert.rejects(
    new OllamaAnswerGenerator(failingClient, config.llm, '5m').generate(context),
    /model not found/u,
  );
  const client = new Ollama({
    fetch: async () =>
      new Response(JSON.stringify({ message: { content: 'Answer [99]' } }), {
        headers: { 'Content-Type': 'application/json' },
      }),
  });
  await assert.rejects(
    new OllamaAnswerGenerator(client, config.llm, '5m').generate(context),
    /source/u,
  );
});
