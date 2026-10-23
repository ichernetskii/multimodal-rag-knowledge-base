import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Application } from '../src/application/application.js';
import type { DeploymentConfig } from '../src/config/saas-config.js';
import type {
  ActionInputs,
  ActionName,
  ActionResults,
  ModelProfile,
  Principal,
} from '../src/contracts/public.js';
import { openApplication } from '../src/app/bootstrap.js';
export async function credentialScenario(
  app: Application,
  config: DeploymentConfig,
  user: Principal,
  other: Principal,
  apiOrigin: string,
  ownerToken: string,
) {
  const alias = 'test-' + randomUUID(),
    first = 'synthetic-first-' + randomUUID(),
    second = 'synthetic-second-' + randomUUID();
  const seen: string[] = [];
  let reject = false;
  const provider = createServer((req, res) => {
    seen.push(String(req.headers.authorization ?? ''));
    req.resume();
    if (reject) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: first + ' ' + second }));
      return;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'vault-test' }] }));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { content: 'Verified' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 1 },
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    }
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  const address = provider.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = 'http://127.0.0.1:' + address.port + '/v1',
    previous = process.env.AI_ALLOWED_ENDPOINTS;
  process.env.AI_ALLOWED_ENDPOINTS = [previous, endpoint].filter(Boolean).join(',');
  const worker = await openApplication(config);
  const call = <N extends ActionName>(action: N, p: ActionInputs[N], principal = user) =>
    app.execute(action, p as Record<string, unknown>, principal) as Promise<ActionResults[N]>;
  let p1: ModelProfile | undefined, p2: ModelProfile | undefined;
  try {
    // This consumer is initialized before the key exists, as a long-running worker would be.
    const saved = await call('secrets.save', {
      id: alias,
      label: 'Integration credential',
      provider: 'openai-compatible',
      enabled: true,
      revision: 0,
      value: first,
    });
    assert.ok(!JSON.stringify(saved).includes(first));
    assert.equal(saved.uses, 0);
    const ownerList = await fetch(apiOrigin + '/api/actions/secrets.list', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + ownerToken,
        'X-Tenant-ID': user.tenant,
      },
      body: '{}',
    });
    assert.equal(ownerList.status, 200);
    assert.equal(ownerList.headers.get('cache-control'), 'no-store');
    assert.ok(!(await ownerList.text()).includes(first));
    const anonymous = await fetch(apiOrigin + '/api/actions/secrets.list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(anonymous.status, 401);
    const csrf = await fetch(apiOrigin + '/api/actions/secrets.save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'rag_session=' + ownerToken,
        Origin: 'https://untrusted.invalid',
        'X-Tenant-ID': user.tenant,
      },
      body: JSON.stringify({
        id: alias,
        label: saved.label,
        provider: saved.provider,
        enabled: true,
        revision: saved.revision,
        value: second,
      }),
    });
    assert.equal(csrf.status, 403);
    await assert.rejects(
      call('secrets.save', {
        id: alias,
        label: saved.label,
        provider: saved.provider,
        enabled: true,
        revision: saved.revision,
        value: '',
      }),
      /printable/u,
    );

    await app.s.db.tenant(user.tenant, user.id, async () => {
      const [row] = await app.s.db.query<{ ciphertext: Buffer }>(
        'SELECT ciphertext FROM ai_credentials WHERE id=$1',
        [alias],
      );
      assert.ok(row);
      assert.ok(!row.ciphertext.includes(Buffer.from(first)));
    });
    const template = (await call('models.list', {})).find((p) => p.role === 'generation')!;
    p1 = await call('models.save', {
      profile: {
        ...template,
        id: randomUUID(),
        revision: 0,
        name: 'Vault connection',
        provider: 'openai-compatible',
        model: 'vault-test',
        endpoint,
        input: ['text'],
        secretRef: alias,
        enabled: true,
      },
    });
    p2 = await call('models.save', { profile: { ...p1, id: randomUUID(), revision: 0 } }, other);
    assert.equal(
      (await call('secrets.list', {})).find((k) => k.id === alias)?.uses,
      2,
      'References include another company despite model RLS.',
    );
    const health = () => worker.s.db.tenant(user.tenant, user.id, () => worker.s.ai.health(p1!));
    assert.equal((await health()).ok, true);
    assert.equal(seen.at(-1), 'Bearer ' + first);
    const rotated = await call('secrets.save', {
      id: saved.id,
      label: saved.label,
      provider: saved.provider,
      enabled: saved.enabled,
      revision: saved.revision,
      value: second,
    });
    assert.ok(rotated.revision > saved.revision);
    assert.equal((await health()).ok, true);
    assert.equal(seen.at(-1), 'Bearer ' + second);
    await worker.s.db.tenant(user.tenant, user.id, async () => {
      let answer = '';
      await worker.s.ai.generate(
        p1!,
        { system: 'test', history: [], question: [{ kind: 'text', text: 'test' }], context: [] },
        randomUUID(),
        AbortSignal.timeout(2000),
        (t) => {
          answer += t;
        },
      );
      assert.equal(answer, 'Verified');
    });
    await assert.rejects(
      call('secrets.save', {
        id: alias,
        label: 'stale',
        provider: 'openai-compatible',
        enabled: true,
        revision: saved.revision,
        value: first,
      }),
      /changed/u,
    );
    const off = await call('secrets.save', {
      id: alias,
      label: saved.label,
      provider: saved.provider,
      revision: rotated.revision,
      enabled: false,
    });
    const before = seen.length;
    assert.equal((await health()).ok, false);
    assert.equal(seen.length, before, 'Disabled credentials never reach the provider.');
    const on = await call('secrets.save', {
      id: alias,
      label: saved.label,
      provider: saved.provider,
      revision: off.revision,
      enabled: true,
    });
    reject = true;
    const denied = await health();
    assert.equal(denied.ok, false);
    assert.ok(!JSON.stringify(denied).includes(first) && !JSON.stringify(denied).includes(second));
    reject = false;
    const concurrent = await Promise.allSettled(
      ['a', 'b'].map((label) =>
        call('secrets.save', {
          id: alias,
          label,
          provider: saved.provider,
          enabled: true,
          revision: on.revision,
        }),
      ),
    );
    assert.equal(concurrent.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter((r) => r.status === 'rejected').length, 1);
    for (const role of ['admin', 'editor', 'user'] as const) {
      const member = await call('users.create', {
        login: 'key-' + role + '-' + randomUUID(),
        password: 'integration-test-pass',
        role,
        groups: [],
        blocked: false,
      });
      const account = await app.s.identity.login(
        member.login,
        'integration-test-pass',
        'credential-test',
      );
      const principal = await app.s.identity.current(member.id, user.tenant);
      for (const [action, payload] of [
        ['secrets.list', {}],
        ['secrets.audit', {}],
        ['secrets.delete', { id: alias, revision: on.revision }],
        [
          'secrets.save',
          {
            id: alias,
            label: 'forbidden',
            provider: saved.provider,
            enabled: true,
            revision: on.revision,
            value: first,
          },
        ],
      ] as const) {
        const response = await fetch(apiOrigin + '/api/actions/' + action, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + account.token,
            'X-Tenant-ID': user.tenant,
          },
          body: JSON.stringify(payload),
        });
        assert.equal(response.status, 403);
        assert.ok(!(await response.text()).includes(first));
      }
      assert.ok(
        (await call('models.list', {}, principal)).every((p) => !p.secretRef && !p.endpoint),
      );
    }
    const latest = (await call('secrets.list', {})).find((k) => k.id === alias)!;
    await assert.rejects(
      call('secrets.save', {
        id: latest.id,
        label: latest.label,
        provider: 'google',
        enabled: latest.enabled,
        revision: latest.revision,
      }),
      /different provider/u,
    );
    await assert.rejects(
      call('models.save', {
        profile: { ...p1, id: randomUUID(), revision: 0, secretRef: 'missing-key' },
      }),
      /saved key/u,
    );
    await assert.rejects(
      call('models.save', {
        profile: {
          ...p1,
          id: randomUUID(),
          revision: 0,
          provider: 'google',
          endpoint: 'https://generativelanguage.googleapis.com',
        },
      }),
      /same provider/u,
    );
    assert.ok(!JSON.stringify(await call('secrets.audit', {})).includes(first));
    await call('models.delete', { id: p1.id, revision: p1.revision });
    p1 = undefined;
    await assert.rejects(
      call('secrets.delete', { id: alias, revision: latest.revision }),
      /is used/u,
      'An unseen company reference must still prevent deletion.',
    );
    await call('models.delete', { id: p2.id, revision: p2.revision }, other);
    p2 = undefined;
    await call('secrets.delete', { id: alias, revision: latest.revision });
    const recreated = await call('secrets.save', {
      id: alias,
      label: 'Recreated',
      provider: saved.provider,
      enabled: true,
      revision: 0,
      value: second,
    });
    assert.ok(recreated.revision > latest.revision);
    await assert.rejects(
      call('secrets.delete', { id: alias, revision: latest.revision }),
      /changed/u,
      'Recreating an alias must not allow a stale editor to delete its replacement.',
    );
  } finally {
    for (const [p, principal] of [
      [p1, user],
      [p2, other],
    ] as const)
      if (p)
        await call('models.delete', { id: p.id, revision: p.revision }, principal).catch(() => {});
    const latest = (await call('secrets.list', {})).find((k) => k.id === alias);
    if (latest) await call('secrets.delete', { id: alias, revision: latest.revision });
    if (previous === undefined) delete process.env.AI_ALLOWED_ENDPOINTS;
    else process.env.AI_ALLOWED_ENDPOINTS = previous;
    await worker.close();
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
  }
}
