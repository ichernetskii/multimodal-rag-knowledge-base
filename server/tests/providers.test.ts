import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GoogleAdapter,
  AnthropicAdapter,
  CompatibleAdapter,
} from '../src/infrastructure/models/provider-adapters.js';
import { initialProfiles } from '../src/config/default-settings.js';
import { loadDeployment } from '../src/config/saas-config.js';
const profiles = initialProfiles(
  loadDeployment({ NODE_ENV: 'test', APP_ENCRYPTION_KEY: '1'.repeat(64) }),
);
const localGeneration = profiles.find((p) => p.provider === 'ollama' && p.role === 'generation')!;
const localEmbedding = profiles.find((p) => p.provider === 'ollama' && p.role === 'embedding')!;

void test('Ollama availability checks the selected installed model and its capabilities', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.ok((url instanceof Request ? url.url : url.toString()).endsWith('/api/show'));
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as { model: string };
    assert.equal(body.model, localGeneration.model);
    return Response.json({ capabilities: ['completion', 'vision'] });
  });
  await new CompatibleAdapter('', true).health(localGeneration, AbortSignal.timeout(1000));
});
void test('reachable Ollama without the selected model reports missing weights', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('private diagnostic', { status: 404 }),
  );
  await assert.rejects(
    new CompatibleAdapter('', true).health(localGeneration, AbortSignal.timeout(1000)),
    /не загружена в Ollama/u,
  );
});
void test('Ollama rejects a text-only model advertised as a vision model', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ capabilities: ['completion'] }));
  await assert.rejects(
    new CompatibleAdapter('', true).health(localGeneration, AbortSignal.timeout(1000)),
    /не поддерживает изображения/u,
  );
});
void test('Ollama checks the embedding role and native vector dimensions', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ capabilities: ['embedding'], model_info: { 'gemma3.embedding_length': 768 } }),
  );
  await new CompatibleAdapter('', true).health(localEmbedding, AbortSignal.timeout(1000));
  await assert.rejects(
    new CompatibleAdapter('', true).health(
      { ...localEmbedding, dimensions: 1536 },
      AbortSignal.timeout(1000),
    ),
    /Размерность/u,
  );
  mock.mock.mockImplementation(async () => Response.json({ capabilities: ['completion'] }));
  await assert.rejects(
    new CompatibleAdapter('', true).health(localEmbedding, AbortSignal.timeout(1000)),
    /не поддерживает выбранную задачу/u,
  );
});
void test('Ollama embeddings request the index dimensions and reject silent input truncation', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as {
      dimensions: number;
      truncate: boolean;
    };
    assert.equal(body.dimensions, 768);
    assert.equal(body.truncate, false);
    return Response.json({ embeddings: [Array(768).fill(0.01)], prompt_eval_count: 5 });
  });
  const result = await new CompatibleAdapter('', true).embed(
    localEmbedding,
    [{ kind: 'text', text: 'service interval' }],
    AbortSignal.timeout(1000),
  );
  assert.equal(result.vector.length, 768);
  assert.equal(result.usage.input, 5);
});

void test('Google streaming transports native modalities and never places secrets in the URL', async (t) => {
  const profile = profiles[0]!;
  let body: Record<string, unknown> = {};
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.ok(
      (input instanceof Request ? input.url : input.toString()).endsWith(
        ':streamGenerateContent?alt=sse',
      ),
    );
    assert.ok(!(input instanceof Request ? input.url : input.toString()).includes('test-secret'));
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'test-secret');
    body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as Record<string, unknown>;
    return new Response(
      'data: ' +
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: 'reasoning', thought: true }, { text: 'Answer [1]' }] } },
          ],
          usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 4, thoughtsTokenCount: 10 },
        }) +
        '\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
  let answer = '';
  const usage = await new GoogleAdapter('test-secret').generate(
    profile,
    {
      system: 'Use sources',
      history: [],
      question: [{ kind: 'text', text: 'What is shown?' }],
      context: [
        { kind: 'image', bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' },
        { kind: 'audio', bytes: new Uint8Array([4, 5]), mime: 'audio/wav' },
        { kind: 'video', bytes: new Uint8Array([6]), mime: 'video/mp4' },
      ],
    },
    AbortSignal.timeout(1000),
    (v) => {
      answer += v;
    },
  );
  assert.equal(answer, 'Answer [1]');
  assert.equal(usage.output, 14);
  assert.ok(JSON.stringify(body).includes('inlineData'));
  assert.ok(JSON.stringify(body).includes('audio/wav'));
  assert.ok(JSON.stringify(body).includes('video/mp4'));
  assert.ok(!JSON.stringify(body).includes('temperature'));
});
void test('Google embedding uses a joint multimodal request and a conservative usage fallback', async (t) => {
  const profile = profiles[1]!;
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as {
      content: { parts: unknown[] };
      outputDimensionality: number;
    };
    assert.equal(body.content.parts.length, 2);
    assert.equal(body.outputDimensionality, profile.dimensions);
    return Response.json({ embedding: { values: [0.1, 0.2] } });
  });
  const result = await new GoogleAdapter('test-secret').embed(
    profile,
    [
      { kind: 'text', text: 'Elephant' },
      { kind: 'image', bytes: new Uint8Array([1]), mime: 'image/jpeg' },
    ],
    AbortSignal.timeout(1000),
  );
  assert.deepEqual(result.vector, [0.1, 0.2]);
  assert.equal(result.usage.input, profile.contextTokens);
});
void test('provider rejection exposes a bounded code without echoing provider data', async (t) => {
  t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(new Response('sensitive-provider-diagnostic', { status: 429 })),
  );
  await assert.rejects(
    new GoogleAdapter('test-secret').embed(
      profiles[1]!,
      [{ kind: 'text', text: 'question' }],
      AbortSignal.timeout(1000),
    ),
    (e) =>
      e instanceof Error &&
      'code' in e &&
      e.code === 'PROVIDER_RATE_LIMIT' &&
      !e.message.includes('sensitive'),
  );
});
void test('Anthropic asks for ephemeral prompt caching and streams text', async (t) => {
  const profile = profiles.find((p) => p.provider === 'anthropic')!;
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    assert.ok((typeof init?.body === 'string' ? init.body : '').includes('cache_control'));
    return new Response(
      'data: ' +
        JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Source [1]' },
        }) +
        '\n\ndata: ' +
        JSON.stringify({ type: 'message_delta', usage: { output_tokens: 3 } }) +
        '\n\n',
    );
  });
  let answer = '';
  await new AnthropicAdapter('test-secret').generate(
    profile,
    {
      system: 'Authorized sources only',
      history: [],
      question: [{ kind: 'text', text: 'question' }],
      context: [],
    },
    AbortSignal.timeout(1000),
    (v) => {
      answer += v;
    },
  );
  assert.equal(answer, 'Source [1]');
});
void test('production configuration fails closed for test AI and absent deployment secrets', () => {
  assert.throws(() => loadDeployment({ NODE_ENV: 'production' }), /APP_ENCRYPTION_KEY/);
  assert.throws(
    () =>
      loadDeployment({
        NODE_ENV: 'production',
        APP_ENCRYPTION_KEY: '1'.repeat(64),
        DATABASE_URL: 'postgres://x',
        REDIS_URL: 'redis://x',
        S3_ENDPOINT: 'http://x',
        S3_ACCESS_KEY: 'x',
        S3_SECRET_KEY: 'x',
        RAG_PUBLIC_ORIGIN: 'https://example.test',
        ALLOW_TEST_AI: '1',
      }),
    /TEST AI/,
  );
});
