import test from 'node:test';
import assert from 'node:assert/strict';
import { Ollama } from 'ollama';
import { loadConfig } from '../src/config.js';
import { loadRuntimeConfig } from '../src/runtime-config.js';
import { RagService } from '../src/core/rag-service.js';
import type { RagStages } from '../src/core/rag-service.js';
import { SourcesContextBuilder } from '../src/generation/context-builder.js';
import { OllamaAnswerGenerator } from '../src/generation/ollama-generator.js';
import type { VectorStore } from '../src/core/contracts.js';
import { chunk, document, hit } from './helpers.js';

function stages(store: VectorStore): RagStages {
  return {
    loader: { load: async () => document('Text') },
    parser: { parse: () => [{ title: 'Section', text: 'Text', startLine: 1, endLine: 1 }] },
    chunker: { chunk: async () => [chunk('First'), chunk('Second', 1)] },
    embedder: {
      describe: async () => ({ model: 'test', digest: 'test', dimensions: 3 }),
      embed: async (inputs) => ({ vectors: inputs.map(() => [1, 0, 0]) }),
      close: () => {},
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

void test('Empty retrieval returns a fixed English message without context building or generation', async () => {
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
  for (const question of ['What is the bonus?', 'Какой размер премии?', 'API?']) {
    const implementations = stages(store);
    implementations.contextBuilder.build = () => {
      throw new Error('The context builder must not be called');
    };
    implementations.generator.generate = async () => {
      throw new Error('The LLM must not be called');
    };
    const result = await new RagService(implementations, 16).ask(question);
    assert.equal(result.answer, 'The documents do not contain enough information.');
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.hits, []);
  }
});

void test('A Russian question keeps its language instruction with English source text', () => {
  const context = new SourcesContextBuilder(loadConfig({}).context).build('Кто согласует отпуск?', [
    hit('The direct manager approves leave.'),
  ]);
  assert.match(context.messages[0]?.content ?? '', /language of the user's question/u);
  assert.match(context.messages[0]?.content ?? '', /question's language, without citations/u);
  assert.ok(context.messages[1]?.content.includes('Кто согласует отпуск?'));
  assert.equal(context.sources[0]?.text, 'The direct manager approves leave.');
});

void test('The context builder rejects over-budget questions and missing usable sources', () => {
  const builder = new SourcesContextBuilder({ ...loadConfig({}).context, maxCharacters: 1000 });
  assert.throws(
    () => builder.build('x'.repeat(1000), [hit('Short text')]),
    /question and instruction/u,
  );
  assert.throws(() => builder.build('Question?', []), /chunks do not fit/u);
  assert.throws(() => builder.build('Question?', [hit('x'.repeat(2000))]), /chunks do not fit/u);
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
