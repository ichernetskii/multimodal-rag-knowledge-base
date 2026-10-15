import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createClientServer } from '../scripts/gateway.ts';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  return 'http://127.0.0.1:' + address.port;
}
it('serves independent client assets, cacheable files, routes and JSON API errors', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rag-gateway-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'assets'));
  writeFileSync(join(directory, 'index.html'), '<h1>Client</h1>');
  writeFileSync(join(directory, 'assets', 'app.js'), 'console.log(1)');
  const api = await listen(
    createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', path: req.url } }));
    }),
  );
  const client = await listen(createClientServer({ directory, apiUrl: api }));
  expect((await fetch(client + '/admin/users')).status).toBe(200);
  expect(await (await fetch(client + '/')).text()).toContain('Client');
  expect((await fetch(client + '/_client/health')).status).toBe(200);
  const asset = await fetch(client + '/assets/app.js');
  expect(asset.headers.get('cache-control')).toContain('immutable');
  expect(asset.headers.get('content-security-policy')).toContain("script-src 'self'");
  expect(
    (
      await fetch(client + '/assets/app.js', {
        headers: { 'If-None-Match': asset.headers.get('etag')! },
      })
    ).status,
  ).toBe(304);
  const missing = await fetch(client + '/api/missing');
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
});
it('keeps the client available when the API is down', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rag-client-only-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'index.html'), 'Client shell');
  const client = await listen(createClientServer({ directory, apiUrl: 'http://127.0.0.1:1' }));
  expect(await (await fetch(client + '/')).text()).toBe('Client shell');
  const response = await fetch(client + '/api/actions/me', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ error: { code: 'SERVER_UNAVAILABLE' } });
});
it('negotiates real precompressed assets and rejects encoded traversal', async () => {
  const { gzipSync, brotliCompressSync } = await import('node:zlib'),
    directory = mkdtempSync(join(tmpdir(), 'rag-compression-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'assets'));
  const body = 'const example="client";'.repeat(200),
    path = join(directory, 'assets', 'app.js');
  writeFileSync(join(directory, 'index.html'), 'Client');
  writeFileSync(path, body);
  writeFileSync(path + '.gz', gzipSync(body));
  writeFileSync(path + '.br', brotliCompressSync(body));
  const client = await listen(createClientServer({ directory, apiUrl: 'http://127.0.0.1:1' }));
  const response = await fetch(client + '/assets/app.js', {
    headers: { 'Accept-Encoding': 'br, gzip' },
  });
  expect(response.headers.get('content-encoding')).toBe('br');
  expect(await response.text()).toBe(body);
  const identity = await fetch(client + '/assets/app.js', {
    headers: { 'Accept-Encoding': 'br;q=0,gzip;q=0' },
  });
  expect(identity.headers.get('content-encoding')).toBeNull();
  expect(await identity.text()).toBe(body);
  expect((await fetch(client + '/%2e%2e%2fpackage.json')).status).toBe(404);
  expect((await fetch(client + '/assets/missing')).status).toBe(404);
});
it('forwards SSE immediately and propagates cancellation to the upstream connection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rag-stream-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'index.html'), 'Client');
  let closed!: () => void;
  const ended = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const upstream = await listen(
    createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
      res.write('event: snapshot\ndata: {"status":"generating"}\n\n');
      res.on('close', closed);
    }),
  );
  const client = await listen(createClientServer({ directory, apiUrl: upstream })),
    controller = new AbortController(),
    response = await fetch(client + '/api/events/job', { signal: controller.signal }),
    reader = response.body!.getReader();
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('generating');
  controller.abort();
  await expect(
    Promise.race([
      ended,
      new Promise((_, reject) => setTimeout(() => reject(new Error('upstream still open')), 1500)),
    ]),
  ).resolves.toBeUndefined();
});
