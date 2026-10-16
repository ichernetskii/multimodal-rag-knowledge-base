import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Application } from '../src/application/application.js';
import type { ModelProfile, Principal } from '../src/contracts/public.js';
import { reservation } from '../src/features/models/billing.js';
export async function billingScenario(app: Application, user: Principal, other: Principal) {
  let calls = 0,
    reject = false,
    noUsage = false;
  const server = createServer((req, res) => {
    req.resume();
    calls++;
    res.writeHead(reject ? 429 : 200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        reject
          ? { error: 'rate limit' }
          : {
              embedding: { values: Array.from({ length: 128 }, () => 0.1) },
              ...(!noUsage
                ? {
                    usageMetadata: {
                      promptTokenCount: 1200,
                      promptTokenDetails: [
                        { modality: 'TEXT', tokenCount: 100 },
                        { modality: 'IMAGE', tokenCount: 200 },
                        { modality: 'AUDIO', tokenCount: 300 },
                        { modality: 'VIDEO', tokenCount: 600 },
                      ],
                    },
                  }
                : {}),
            },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = 'http://127.0.0.1:' + address.port,
    previous = process.env.AI_ALLOWED_ENDPOINTS;
  process.env.AI_ALLOWED_ENDPOINTS = [previous, endpoint].filter(Boolean).join(',');
  const id = randomUUID(),
    alias = 'billing-' + id;
  let profile: ModelProfile;
  const run = <T>(fn: () => Promise<T>) => app.s.db.tenant(user.tenant, user.id, fn);
  try {
    await run(() =>
      app.s.ai.credentials.save(user, {
        id: alias,
        label: 'Billing test',
        provider: 'google',
        revision: 0,
        enabled: true,
        value: 'synthetic-billing-key',
      }),
    );
    profile = await run(async () => {
      const source = (await app.s.db.list<ModelProfile>('model')).find(
        (p) => p.role === 'embedding',
      )!;
      return app.administration.modelsSave(user, {
        profile: {
          ...source,
          id,
          revision: 0,
          provider: 'google',
          model: 'gemini-embedding-2',
          endpoint,
          secretRef: alias,
          contextTokens: 8192,
          input: ['text', 'image', 'audio', 'video', 'pdf'],
          dimensions: 128,
          cache: true,
          inputMicrosPerMillion: { text: 200000, image: 450000, audio: 6500000, video: 12000000 },
        },
      });
    });
    const parts = [
      { kind: 'text' as const, text: id },
      { kind: 'image' as const, bytes: new Uint8Array([1]), mime: 'image/png' },
      { kind: 'audio' as const, bytes: new Uint8Array([1]), mime: 'audio/wav', seconds: 1 },
      { kind: 'video' as const, bytes: new Uint8Array([1]), mime: 'video/mp4', seconds: 1 },
    ];
    await run(() => app.s.ai.embed(profile, parts, randomUUID(), AbortSignal.timeout(5000)));
    await run(() => app.s.ai.embed(profile, parts, randomUUID(), AbortSignal.timeout(5000)));
    assert.equal(calls, 1, 'Cache hits do not create paid calls.');
    const report = await run(() => app.administration.usage());
    const billed = report.calls.find((c) => c.profile === id)!;
    assert.equal(billed.costMicros, 9260);
    assert.equal(billed.modalities.audio.tokens, 300);
    assert.equal(billed.estimatedCalls, 0);
    const isolated = await app.s.db.tenant(other.tenant, other.id, () =>
      app.administration.usage(),
    );
    assert.ok(!isolated.calls.some((c) => c.profile === id));
    noUsage = true;
    await run(() =>
      app.s.ai.embed({ ...profile, cache: false }, parts, randomUUID(), AbortSignal.timeout(5000)),
    );
    assert.equal(
      (await run(() => app.administration.usage())).calls.find((c) => c.profile === id)
        ?.estimatedCalls,
      1,
    );
    reject = true;
    await assert.rejects(
      run(() =>
        app.s.ai.embed(
          { ...profile, cache: false },
          parts,
          randomUUID(),
          AbortSignal.timeout(5000),
        ),
      ),
    );
    const rows = await run(() =>
      app.s.db.query<{ state: string }>(
        'SELECT state FROM usage_ledger WHERE tenant_id=$1 AND profile=$2 ORDER BY created',
        [user.tenant, id],
      ),
    );
    assert.equal(rows.at(-1)?.state, 'released');
    const settings = await run(() => app.s.identity.settings());
    const spent = (await run(() => app.administration.usage())).spentMicros;
    await run(() =>
      app.s.db.query('UPDATE tenants SET settings=$1 WHERE id=$2', [
        JSON.stringify({
          ...settings,
          monthlyBudgetMicros: spent + reservation(profile, parts).costMicros,
        }),
        user.tenant,
      ]),
    );
    const simultaneous = await Promise.allSettled(
      [1, 2].map(() => run(() => app.s.ai.reserve(profile, randomUUID(), parts))),
    );
    assert.equal(
      simultaneous.filter((r) => r.status === 'fulfilled').length,
      1,
      'Concurrent reservations cannot overspend one available request.',
    );
    for (const result of simultaneous)
      if (result.status === 'fulfilled')
        await run(() =>
          app.s.db.query("UPDATE usage_ledger SET state='released' WHERE tenant_id=$1 AND id=$2", [
            user.tenant,
            result.value,
          ]),
        );
    await run(() =>
      app.s.db.query('UPDATE tenants SET settings=$1 WHERE id=$2', [
        JSON.stringify({ ...settings, monthlyBudgetMicros: 1 }),
        user.tenant,
      ]),
    );
    const before = calls;
    try {
      const outcomes = await Promise.allSettled(
        [1, 2].map(() =>
          run(() =>
            app.s.ai.embed(
              { ...profile, cache: false },
              parts,
              randomUUID(),
              AbortSignal.timeout(5000),
            ),
          ),
        ),
      );
      assert.ok(outcomes.every((v) => v.status === 'rejected'));
      assert.equal(calls, before, 'Budget rejects before external I/O.');
    } finally {
      await run(() =>
        app.s.db.query('UPDATE tenants SET settings=$1 WHERE id=$2', [
          JSON.stringify(settings),
          user.tenant,
        ]),
      );
    }
  } finally {
    await run(() => app.s.db.remove('model', id));
    const credential = (await run(() => app.s.ai.credentials.list(user))).find(
      (k) => k.id === alias,
    );
    if (credential)
      await run(() =>
        app.s.ai.credentials.remove(user, { id: alias, revision: credential.revision }),
      );
    if (previous === undefined) delete process.env.AI_ALLOWED_ENDPOINTS;
    else process.env.AI_ALLOWED_ENDPOINTS = previous;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
