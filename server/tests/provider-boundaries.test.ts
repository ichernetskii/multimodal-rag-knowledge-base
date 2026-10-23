import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  GoogleAdapter,
  AnthropicAdapter,
  CompatibleAdapter,
} from '../src/infrastructure/models/provider-adapters.js';
import { initialProfiles } from '../src/config/default-settings.js';
import { loadDeployment } from '../src/config/saas-config.js';
import type { GenerationInput } from '../src/application/ports/ai.js';

const profiles = initialProfiles(
  loadDeployment({ NODE_ENV: 'test', APP_ENCRYPTION_KEY: '1'.repeat(64) }),
);
const input: GenerationInput = {
  system: 'Use sources',
  history: [],
  context: [],
  question: [{ kind: 'text', text: 'Question' }],
};
const sse = (...events: object[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
const cases = [
  {
    name: 'Google',
    adapter: new GoogleAdapter('fixture-key'),
    profile: profiles.find((p) => p.provider === 'google' && p.role === 'generation')!,
    partial: sse({ candidates: [{ content: { parts: [{ text: 'Partial answer' }] } }] }),
    complete: sse({ candidates: [{ finishReason: 'STOP' }] }),
    limited: sse({ candidates: [{ finishReason: 'MAX_TOKENS' }] }),
  },
  {
    name: 'Anthropic',
    adapter: new AnthropicAdapter('fixture-key'),
    profile: profiles.find((p) => p.provider === 'anthropic')!,
    partial: sse({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Partial answer' },
    }),
    complete: sse(
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ),
    limited: sse(
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
      { type: 'message_stop' },
    ),
  },
  {
    name: 'OpenAI-compatible',
    adapter: new CompatibleAdapter('fixture-key'),
    profile: profiles.find((p) => p.provider === 'google' && p.role === 'generation')!,
    partial: sse({ choices: [{ delta: { content: 'Partial answer' }, finish_reason: null }] }),
    complete: sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n',
    limited: sse({ choices: [{ delta: {}, finish_reason: 'length' }] }) + 'data: [DONE]\n\n',
  },
  {
    name: 'Ollama',
    adapter: new CompatibleAdapter('', true),
    profile: profiles.find((p) => p.provider === 'ollama' && p.role === 'generation')!,
    partial: JSON.stringify({ message: { content: 'Partial answer' }, done: false }) + '\n',
    complete: JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' }),
    limited: JSON.stringify({ done: true, done_reason: 'length' }),
  },
];

void test('provider streams require an explicit complete answer and reject output truncation', async (t) => {
  for (const fixture of cases)
    for (const ending of ['complete', 'partial', 'limited'] as const)
      await t.test(`${fixture.name}: ${ending}`, async (child) => {
        const body = fixture.partial + (ending === 'partial' ? '' : fixture[ending]);
        // Chunk boundaries deliberately split UTF-8/JSON/SSE records.
        const bytes = new TextEncoder().encode(body);
        child.mock.method(
          globalThis,
          'fetch',
          async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  for (let offset = 0; offset < bytes.length; offset += 7)
                    controller.enqueue(bytes.slice(offset, offset + 7));
                  controller.close();
                },
              }),
            ),
        );
        let answer = '';
        const result = fixture.adapter.generate(
          fixture.profile,
          input,
          AbortSignal.timeout(1000),
          (part) => {
            answer += part;
          },
        );
        if (ending === 'complete') {
          await result;
          assert.equal(answer, 'Partial answer');
        } else {
          await assert.rejects(result, { code: 'GENERATION_INCOMPLETE' });
        }
      });
});

void test('provider redirects cannot forward API credentials or request bodies', async (t) => {
  let forwarded = 0;
  const target = createServer((_req, res) => {
    forwarded++;
    res.end('{}');
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress === 'object');
  const source = createServer((_req, res) => {
    res.writeHead(307, { Location: `http://127.0.0.1:${targetAddress.port}/capture` });
    res.end();
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const server of [source, target]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  const address = source.address();
  assert.ok(address && typeof address === 'object');
  for (const fixture of cases) {
    const profile = { ...fixture.profile, endpoint: `http://127.0.0.1:${address.port}` };
    await assert.rejects(fixture.adapter.health(profile, AbortSignal.timeout(1000)), {
      code: 'PROVIDER_REJECTED',
    });
    if (fixture.name !== 'Anthropic')
      await assert.rejects(
        fixture.adapter.embed(profile, input.question, AbortSignal.timeout(1000)),
        { code: 'PROVIDER_REJECTED' },
      );
    await assert.rejects(
      fixture.adapter.generate(profile, input, AbortSignal.timeout(1000), () => {}),
      { code: 'PROVIDER_REJECTED' },
    );
  }
  assert.equal(forwarded, 0);
});
