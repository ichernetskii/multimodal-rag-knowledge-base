import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Application } from '../src/application/application.js';
import type { ModelProfile, Principal } from '../src/contracts/public.js';

export async function transcriptionScenario(app: Application, user: Principal) {
  const bytes = await readFile(
    new URL('../../examples/knowledge-base/media/jfk.wav', import.meta.url),
  );
  let finishReason = 'STOP',
    calls = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        assert.ok(Buffer.isBuffer(chunk));
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        contents: { parts: { inlineData?: { mimeType: string; data: string } }[] }[];
      };
      assert.equal(req.headers['x-goog-api-key'], 'test-transcription-key');
      const audio = body.contents[0]!.parts.find((part) => part.inlineData)?.inlineData;
      assert.equal(audio?.mimeType, 'audio/wav');
      assert.deepEqual(Buffer.from(audio.data, 'base64'), bytes);
      calls++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: 'Ask not what your country can do for you.' }] },
                finishReason,
              },
            ],
            usageMetadata: {
              promptTokenCount: 25,
              candidatesTokenCount: 10,
              promptTokensDetails: [
                { modality: 'AUDIO', tokenCount: 20 },
                { modality: 'TEXT', tokenCount: 5 },
              ],
            },
          }) +
          '\n\n',
      );
    })().catch((error: unknown) => res.destroy(error instanceof Error ? error : undefined));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = 'http://127.0.0.1:' + address.port,
    previous = process.env.AI_ALLOWED_ENDPOINTS;
  process.env.AI_ALLOWED_ENDPOINTS = [previous, endpoint].filter(Boolean).join(',');
  const run = <T>(work: () => Promise<T>) => app.s.db.tenant(user.tenant, user.id, work);
  const alias = 'transcription-' + randomUUID();
  let profile: ModelProfile | undefined;
  try {
    await run(() =>
      app.s.ai.credentials.save(user, {
        id: alias,
        revision: 0,
        label: 'Test ASR',
        provider: 'google',
        enabled: true,
        value: 'test-transcription-key',
      }),
    );
    const template = ((await app.execute('models.list', {}, user)) as ModelProfile[]).find(
      (p) => p.role === 'transcription' && p.provider === 'google',
    )!;
    profile = (await app.execute(
      'models.save',
      {
        profile: {
          ...template,
          id: randomUUID(),
          revision: 0,
          endpoint,
          secretRef: alias,
          enabled: true,
        },
      },
      user,
    )) as ModelProfile;
    const job = randomUUID();
    const transcript = await run(() =>
      app.s.ai.transcribe(profile!, bytes, job, AbortSignal.timeout(5000), 11),
    );
    assert.equal(transcript, 'Ask not what your country can do for you.');
    const [usage] = await run(() =>
      app.s.db.query<{
        state: string;
        cost_micros: string;
        input_tokens: string;
        output_tokens: string;
      }>('SELECT * FROM usage_ledger WHERE tenant_id=$1 AND job_id=$2', [user.tenant, job]),
    );
    assert.equal(usage?.state, 'complete');
    assert.equal(Number(usage?.input_tokens), 25);
    assert.equal(Number(usage?.output_tokens), 10);
    assert.ok(Number(usage?.cost_micros) > 0);
    finishReason = 'MAX_TOKENS';
    await assert.rejects(
      run(() => app.s.ai.transcribe(profile!, bytes, randomUUID(), AbortSignal.timeout(5000), 11)),
      /complete the transcript/,
    );
    assert.equal(calls, 2);
    await assert.rejects(
      run(() => app.s.ai.transcribe(profile!, bytes, randomUUID(), AbortSignal.timeout(5000), 61)),
      /duration limit/,
    );
    assert.equal(calls, 2);
  } finally {
    if (profile)
      await app.execute('models.delete', { id: profile.id, revision: profile.revision }, user);
    await run(async () => {
      const key = (await app.s.ai.credentials.list(user)).find((key) => key.id === alias);
      if (key) await app.s.ai.credentials.remove(user, { id: alias, revision: key.revision });
    });
    if (previous === undefined) delete process.env.AI_ALLOWED_ENDPOINTS;
    else process.env.AI_ALLOWED_ENDPOINTS = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
