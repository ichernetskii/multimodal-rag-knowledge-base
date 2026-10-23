import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Application } from '../src/application/application.js';
import { createHttpServer } from '../src/interfaces/http/server.js';

void test('HTTP rejects malformed bodies and cookies before calling application services', async (t) => {
  const unexpected = () => assert.fail('Invalid input reached an application service.');
  const app = {
    s: {
      config: { origin: 'http://localhost' },
      identity: { login: unexpected, acceptInvitation: unexpected, principal: unexpected },
    },
    execute: unexpected,
  } as unknown as Application;
  const server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = 'http://127.0.0.1:' + address.port;
  for (const route of ['/api/login', '/api/invitations/accept', '/api/actions/me'])
    for (const body of ['null', '[]', 'true', '42', '"text"', '{']) {
      const response = await fetch(origin + route, { method: 'POST', body });
      assert.equal(response.status, 400, `${route}: ${body}`);
      const result = (await response.json()) as { error: { code: string; diagnostic: string } };
      assert.equal(result.error.code, body === '{' ? 'INVALID_JSON' : 'INVALID_INPUT');
      assert.ok(result.error.diagnostic);
    }
  const response = await fetch(origin + '/api/actions/me', {
    method: 'POST',
    body: '{}',
    headers: { Cookie: 'rag_session=%E0%A4%A', Origin: 'http://localhost' },
  });
  assert.equal(response.status, 401);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    'UNAUTHENTICATED',
  );
});
