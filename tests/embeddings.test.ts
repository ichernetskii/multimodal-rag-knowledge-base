import test from 'node:test';
import assert from 'node:assert/strict';
import { TransformersTextTokenizer } from '../src/tokenization/transformers-tokenizer.js';
import { TransformersEmbeddingProvider } from '../src/embeddings/transformers-embedder.js';
import { padTokenBatch } from '../src/embeddings/transformers-model.js';
import { TokenDocumentChunker } from '../src/chunking/token-chunker.js';
import { TextDocumentParser } from '../src/documents/parser.js';
import { EmbeddingGemmaFormatter } from '../src/embeddings/formatter.js';
import { VectorRetriever } from '../src/retrieval/vector-retriever.js';
import { RagService } from '../src/core/rag-service.js';
import type { RagStages } from '../src/core/rag-service.js';
import type { TokenEmbeddingModel, VectorStore } from '../src/core/contracts.js';
import { loadRuntimeConfig } from '../src/runtime-config.js';
import { chunk, document, wordTokenizer } from './helpers.js';

const options = {
  dimensions: 3,
  modelDimensions: 3,
  maxTokens: 32,
  tokenSafetyMargin: 8,
  vocabularySize: 1000,
};
const info = { model: 'test', digest: 'weights-hash', dimensions: 3 };
function runner(embedding = [3, 4, 0]): TokenEmbeddingModel {
  return {
    signature: 'test-backend',
    embed: async (inputs) => inputs.map(() => embedding),
    close: () => {},
  };
}

void test('Tokenizer prepares immutable IDs and applies the requested special-token policy', () => {
  const calls: boolean[] = [];
  const tokenizer = new TransformersTextTokenizer(
    {
      encode: (_text, flags) => {
        calls.push(flags.add_special_tokens);
        return [2, 17, 1];
      },
    },
    'model-a',
  );
  const input = tokenizer.encode('Text');
  tokenizer.encode('Overlap', { includeSpecialTokens: false });
  assert.deepEqual(input.tokenIds, [2, 17, 1]);
  assert.equal(input.tokenizerSignature, 'model-a');
  assert.deepEqual(calls, [true, false]);
  assert.ok(Object.isFrozen(input.tokenIds));
  assert.ok(Object.isFrozen(input));
});

void test('Chunking retains the selected tokenization instead of encoding it a second time', async () => {
  const counts = new Map<string, number>();
  const tokenizer = {
    ...wordTokenizer,
    encode: (text: string, flags?: { includeSpecialTokens?: boolean }) => {
      counts.set(text, (counts.get(text) ?? 0) + 1);
      return wordTokenizer.encode(text, flags);
    },
  };
  const source = document(Array.from({ length: 70 }, (_value, i) => 'word' + i).join(' '), 'text');
  const formatter = new EmbeddingGemmaFormatter(loadRuntimeConfig({}).embedding);
  const chunks = await new TokenDocumentChunker(
    tokenizer,
    formatter,
    { targetTokens: 32, overlapTokens: 0, maxCharacters: 4096 },
    2040,
  ).chunk(source, new TextDocumentParser().parse(source));
  assert.ok(chunks.length > 1);
  for (const item of chunks) {
    assert.equal(item.tokenCount, item.tokens.tokenIds.length);
    assert.equal(counts.get(item.embeddingInput), 1);
  }
});

void test('RAG passes the same prepared IDs into embedding inference and waits for both resources', async () => {
  const prepared = chunk('First');
  let calls = 0;
  let stored = false;
  let modelClosed = false;
  const stages: RagStages = {
    loader: { load: async () => document('First') },
    parser: { parse: () => [] },
    chunker: { chunk: async () => [prepared] },
    embedder: {
      describe: async () => info,
      embed: async (inputs) => {
        calls++;
        assert.strictEqual(inputs[0], prepared.tokens);
        assert.strictEqual(inputs[0]?.tokenIds, prepared.tokens.tokenIds);
        return { vectors: [[1, 0, 0]] };
      },
      close: async () => {
        modelClosed = true;
      },
    },
    store: {
      replaceDocument: async () => {
        stored = true;
      },
      search: async () => [],
      stats: async () => ({ documents: 1, chunks: 1, vectors: 1 }),
      close: () => {},
    },
    retriever: { retrieve: async () => [] },
    contextBuilder: { build: () => ({ sources: [], messages: [] }) },
    generator: { generate: async () => '' },
  };
  const rag = new RagService(stages, 16);
  await rag.ingest('test');
  await rag.close();
  assert.equal(calls, 1);
  assert.ok(stored && modelClosed);
});

void test('Embedding inference receives the original token arrays and normalizes sentence vectors', async () => {
  const input = wordTokenizer.encode('Some text');
  const model = runner();
  model.embed = async (inputs) => {
    assert.strictEqual(inputs[0], input.tokenIds);
    return [[3, 4, 0]];
  };
  const provider = new TransformersEmbeddingProvider(model, options, info, wordTokenizer.signature);
  const output = await provider.embed([input]);
  assert.deepEqual(output.vectors, [[0.6, 0.8, 0]]);
  assert.equal(output.inputTokens, input.tokenIds.length);
  assert.deepEqual(await provider.embed([]), { vectors: [], inputTokens: 0 });
});

void test('Wrong tokenizer IDs and over-budget inputs fail before model inference', async () => {
  let calls = 0;
  const model = runner();
  model.embed = async () => {
    calls++;
    return [[1, 0, 0]];
  };
  const provider = new TransformersEmbeddingProvider(model, options, info, 'expected');
  await assert.rejects(
    provider.embed([{ tokenIds: [1], tokenizerSignature: 'wrong' }]),
    /different tokenizer/u,
  );
  for (const ids of [[], [-1], [1.5], [1000], [NaN]]) {
    await assert.rejects(
      provider.embed([{ tokenIds: ids, tokenizerSignature: 'expected' }]),
      /Invalid/u,
    );
  }
  await assert.rejects(
    provider.embed([
      {
        tokenIds: Array.from({ length: 25 }, () => 1),
        tokenizerSignature: 'expected',
      },
    ]),
    /Shorten/u,
  );
  assert.equal(calls, 0);
});

void test('Malformed or zero model vectors are rejected and reduced dimensions are normalized', async () => {
  for (const vector of [
    [1, 0],
    [0, 0, 0],
    [NaN, 0, 0],
  ]) {
    await assert.rejects(
      new TransformersEmbeddingProvider(
        runner(vector),
        options,
        info,
        wordTokenizer.signature,
      ).embed([wordTokenizer.encode('Text')]),
      /invalid|zero/u,
    );
  }
  const model = runner();
  model.embed = async () => [];
  await assert.rejects(
    new TransformersEmbeddingProvider(model, options, info, wordTokenizer.signature).embed([
      wordTokenizer.encode('Text'),
    ]),
    /number/u,
  );
  const provider = new TransformersEmbeddingProvider(
    runner([3, 4, 20]),
    { ...options, dimensions: 2 },
    { ...info, dimensions: 2 },
    wordTokenizer.signature,
  );
  assert.deepEqual((await provider.embed([wordTokenizer.encode('Text')])).vectors, [[0.6, 0.8]]);
});

void test('ONNX batches right-pad IDs and mask padding without changing the source arrays', () => {
  const input = [
    [2, 17, 1],
    [2, 1],
  ];
  const batch = padTokenBatch(input, 0);
  assert.deepEqual(batch.shape, [2, 3]);
  assert.deepEqual([...batch.inputIds], [2n, 17n, 1n, 2n, 1n, 0n]);
  assert.deepEqual([...batch.attentionMask], [1n, 1n, 1n, 1n, 1n, 0n]);
  assert.deepEqual(input, [
    [2, 17, 1],
    [2, 1],
  ]);
  assert.throws(() => padTokenBatch([[]], 0), /empty/u);
});

void test('Question retrieval tokenizes exactly once and sends its vector to the store', async () => {
  let encodes = 0;
  let searches = 0;
  const tokenizer = {
    ...wordTokenizer,
    encode: (text: string) => {
      encodes++;
      return wordTokenizer.encode(text);
    },
  };
  const provider = new TransformersEmbeddingProvider(runner(), options, info, tokenizer.signature);
  const store: VectorStore = {
    replaceDocument: async () => {},
    search: async (vector) => {
      searches++;
      assert.deepEqual(vector, [0.6, 0.8, 0]);
      return [];
    },
    stats: async () => ({ documents: 0, chunks: 0, vectors: 0 }),
    close: () => {},
  };
  await new VectorRetriever(
    new EmbeddingGemmaFormatter(loadRuntimeConfig({}).embedding),
    tokenizer,
    provider,
    store,
    { limit: 5 },
  ).retrieve('Question?');
  assert.equal(encodes, 1);
  assert.equal(searches, 1);
});

void test('Model disposal is idempotent and still happens if storage cleanup fails', async () => {
  let closes = 0;
  const model = runner();
  model.close = async () => {
    closes++;
  };
  const provider = new TransformersEmbeddingProvider(model, options, info, wordTokenizer.signature);
  const rag = new RagService(
    {
      embedder: provider,
      store: {
        close: () => {
          throw new Error('Storage close failed');
        },
      },
    } as unknown as RagStages,
    1,
  );
  await assert.rejects(rag.close(), /Storage close/u);
  await provider.close();
  assert.equal(closes, 1);
  await assert.rejects(provider.embed([wordTokenizer.encode('Text')]), /closed/u);
});
