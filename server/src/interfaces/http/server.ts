import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Application } from '../../application/application.js';
import type { Principal, Turn } from '../../contracts/public.js';
import { terminal } from '../../contracts/public.js';
import { AppError, errorResponse, requireValue } from '../../shared/errors.js';
import { deliveryMetrics } from '../../application/delivery-metrics.js';
import { writeChunk } from './stream-response.js';
const token = (req: IncomingMessage) => {
  if (req.headers.authorization?.startsWith('Bearer ')) return req.headers.authorization.slice(7);
  try {
    return decodeURIComponent(
      /(?:^|;\s*)rag_session=([^;]+)/u.exec(req.headers.cookie ?? '')?.[1] ?? '',
    );
  } catch {
    throw new AppError('UNAUTHENTICATED', 'Invalid session cookie. Sign in again.', 401);
  }
};
const tenant = (req: IncomingMessage, url: URL) =>
  String(req.headers['x-tenant-id'] ?? url.searchParams.get('tenant') ?? '');
let bodyReaders = 0;
async function bytes(req: IncomingMessage, limit: number) {
  requireValue(
    bodyReaders < 16,
    'API_BUSY',
    'Too many concurrent uploads. Retry the saved request.',
    429,
  );
  bodyReaders++;
  try {
    const declared = Number(req.headers['content-length'] ?? 0);
    requireValue(
      Number.isFinite(declared) && declared >= 0 && declared <= limit,
      'REQUEST_LIMIT',
      'Request is too large.',
      413,
    );
    const parts: Buffer[] = [];
    let length = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      length += chunk.length;
      requireValue(length <= limit, 'REQUEST_LIMIT', 'Request is too large.', 413);
      parts.push(chunk);
    }
    return Buffer.concat(parts, length);
  } finally {
    bodyReaders--;
  }
}
const parseJSON = (bytes: Buffer): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString() || '{}') as unknown;
  } catch {
    throw new AppError('INVALID_JSON', 'Invalid JSON body.');
  }
  requireValue(
    value && typeof value === 'object' && !Array.isArray(value),
    'INVALID_INPUT',
    'A JSON object is required.',
  );
  return value as Record<string, unknown>;
};
const send = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
};
export function createHttpServer(app: Application) {
  const s = app.s;
  const server = createServer((req, res) => {
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    void handle(req, res, controller.signal).catch((error) => {
      const e = errorResponse(error);
      if (!res.headersSent) send(res, e.status, { error: e.error });
      else res.destroy();
      if (e.status >= 500)
        console.error(
          JSON.stringify({ level: 'error', code: e.error.code, diagnostic: e.error.diagnostic }),
        );
    });
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  server.maxConnections = 1000;
  async function handle(req: IncomingMessage, res: ServerResponse, signal: AbortSignal) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    );
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('X-Request-ID', randomUUID());
    if (req.method === 'GET' && url.pathname === '/health/live') {
      send(res, 200, { live: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health/ready') {
      try {
        await s.db.query('SELECT 1');
        send(res, 200, { ready: true, redis: s.cache.healthy });
      } catch {
        send(res, 503, { ready: false });
      }
      return;
    }
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method ?? '')) {
      const origin = req.headers.origin;
      requireValue(
        !origin || origin === s.config.origin,
        'ORIGIN_REJECTED',
        'Incorrect request origin.',
        403,
      );
      requireValue(
        !req.headers.cookie || origin === s.config.origin || Boolean(req.headers.authorization),
        'CSRF_REJECTED',
        'Same-origin request required.',
        403,
      );
    }
    if (req.method === 'POST' && url.pathname === '/api/invitations/accept') {
      const p = parseJSON(await bytes(req, 16384));
      requireValue(
        typeof p.token === 'string' && typeof p.password === 'string',
        'INVALID_INPUT',
        'Token and password required.',
      );
      send(res, 200, await s.identity.acceptInvitation(p.token, p.password));
      return;
    }
    if (req.method === 'POST' && ['/api/login', '/api/logout'].includes(url.pathname)) {
      const p = parseJSON(await bytes(req, 16384));
      if (url.pathname === '/api/logout') {
        await s.identity.logout(token(req));
        res.setHeader('Set-Cookie', 'rag_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        send(res, 200, { ok: true });
        return;
      }
      requireValue(
        typeof p.login === 'string' && typeof p.password === 'string',
        'INVALID_INPUT',
        'Login and password required.',
      );
      const result = await s.identity.login(p.login, p.password, req.socket.remoteAddress ?? '');
      res.setHeader(
        'Set-Cookie',
        `rag_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${s.config.origin.startsWith('https:') ? '; Secure' : ''}`,
      );
      send(res, 200, { user: result.user, ...(p.cli === true ? { token: result.token } : {}) });
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/actions/')) {
      const action = url.pathname.slice('/api/actions/'.length);
      const p = parseJSON(await bytes(req, 1024 * 1024));
      const user =
        action === 'setup.status'
          ? undefined
          : await s.identity.principal(token(req), tenant(req, url) || undefined);
      const result = await app.execute(action, p, user, signal);
      if (
        user &&
        ![
          'password.change',
          'sessions.revoke',
          'users.update',
          'users.revoke',
          'tenants.update',
        ].includes(action)
      )
        await s.identity.principal(token(req), user.tenant);
      send(res, action === 'answers.create' ? 202 : 200, result);
      return;
    }
    const user = await s.identity.principal(token(req), tenant(req, url) || undefined);
    await s.db.tenant(user.tenant, user.id, async () => {
      if (req.method === 'PUT' && /^\/api\/uploads\/[^/]+$/u.test(url.pathname)) {
        const data = await bytes(req, 8 * 1024 * 1024);
        const offset = Number(req.headers['upload-offset']);
        requireValue(
          Number.isSafeInteger(offset) && offset >= 0,
          'INVALID_INPUT',
          'Upload-Offset header required.',
        );
        send(
          res,
          200,
          await app.documents.uploadPart(user, url.pathname.split('/')[3]!, offset, data),
        );
        return;
      }
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        /^\/api\/documents\/[^/]+(?:\/media\/[^/]+)?$/u.test(url.pathname)
      ) {
        const parts = url.pathname.split('/'),
          asset = await app.documents.asset(
            user,
            parts[3]!,
            url.searchParams.get('version') ?? '',
            parts[4] === 'media' ? parts[5] : undefined,
          );
        let start = 0,
          end = Number(asset.bytes) - 1;
        const range = req.headers.range;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
          res.setHeader('Content-Range', `bytes */${asset.bytes}`);
          requireValue(
            match && (match[1] || match[2]),
            'INVALID_RANGE',
            'Invalid byte range.',
            416,
          );
          if (match[1]) {
            start = Number(match[1]);
            if (match[2]) end = Math.min(end, Number(match[2]));
          } else start = Math.max(0, Number(asset.bytes) - Number(match[2]));
          requireValue(
            Number.isSafeInteger(start) &&
              Number.isSafeInteger(end) &&
              start >= 0 &&
              start <= end &&
              start < Number(asset.bytes),
            'INVALID_RANGE',
            'Unavailable byte range.',
            416,
          );
          res.setHeader('Content-Range', `bytes ${start}-${end}/${asset.bytes}`);
        }
        res.writeHead(range ? 206 : 200, {
          'Content-Type': asset.mime,
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'Content-Disposition': `${url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        let checked = Date.now();
        for await (const chunk of s.storage.read(
          asset.object_key,
          range ? `bytes=${start}-${end}` : undefined,
          signal,
        )) {
          if (Date.now() - checked > 500) {
            const current = await s.identity.principal(token(req), user.tenant);
            await app.documents.document(current, parts[3]!);
            checked = Date.now();
          }
          await writeChunk(res, chunk, signal);
        }
        res.end();
        return;
      }
      if (req.method === 'GET' && /^\/api\/events\/[^/]+$/u.test(url.pathname)) {
        await stream(req, res, url, user, signal);
        return;
      }
      if (req.method === 'GET' && /^\/api\/conversations\/[^/]+\/export$/u.test(url.pathname)) {
        const id = url.pathname.split('/')[3]!,
          conversation = await app.chat.owns(user, id);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="conversation-${id}.json"`,
        });
        await writeChunk(res, JSON.stringify({ conversation }).slice(0, -1) + ',"turns":[', signal);
        let first = true,
          offset = 0;
        while (true) {
          const turns = await s.db.list<Turn>('turn', 'conversation_id=$2', [id], 100, offset);
          if (!turns.length) break;
          for (const turn of turns) {
            const current = await s.identity.principal(token(req), user.tenant);
            const guarded = await app.chat.guard(current, turn);
            await writeChunk(res, (first ? '' : ',') + JSON.stringify(guarded), signal);
            first = false;
          }
          offset += turns.length;
        }
        await writeChunk(res, '],"exported":' + Date.now() + '}', signal);
        res.end();
        return;
      }
      send(res, 404, {
        error: { code: 'NOT_FOUND', message: 'Route not found.', diagnostic: randomUUID() },
      });
    });
  }
  async function stream(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    user: Principal,
    signal: AbortSignal,
  ) {
    const id = url.pathname.split('/')[3]!;
    await s.queue.read(user, id);
    const release = await s.ai.resources.acquire(
      [
        { key: 'sse:deployment', limit: 128 },
        { key: `sse:tenant:${user.tenant}`, limit: 32 },
        { key: `sse:user:${user.tenant}:${user.id}`, limit: 8 },
      ],
      signal,
    );
    try {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      });
      let after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0),
        heartbeat = 0;
      const until = Date.now() + 30 * 60000;
      while (!signal.aborted && Date.now() < until) {
        try {
          const current = await s.identity.principal(token(req), user.tenant),
            job = await s.queue.read(current, id);
          if (job.updated > after || terminal.has(job.status)) {
            let turn: Turn | undefined;
            const turnId = job.payload.turn;
            if (typeof turnId === 'string') {
              const raw = await s.db.get<Turn>('turn', turnId);
              if (raw) {
                await app.chat.owns(current, raw.conversation);
                turn = await app.chat.guard(current, raw);
              }
            }
            const snapshot = JSON.stringify({ job, ...(turn ? { turn } : {}) });
            requireValue(
              Buffer.byteLength(snapshot) <= 512 * 1024 && res.writableLength < 1024 * 1024,
              'SSE_LIMIT',
              'Stream buffer exceeded.',
              429,
            );
            deliveryMetrics.peakBuffered = Math.max(
              deliveryMetrics.peakBuffered,
              res.writableLength + Buffer.byteLength(snapshot),
            );
            await writeChunk(
              res,
              `id: ${job.updated}\nevent: snapshot\ndata: ${snapshot}\n\n`,
              signal,
            );
            after = job.updated;
            if (terminal.has(job.status)) break;
          }
          if (Date.now() - heartbeat > 5000) {
            await writeChunk(res, ': heartbeat\n\n', signal);
            heartbeat = Date.now();
          }
          await new Promise((r) => setTimeout(r, 250));
        } catch (e) {
          if (e instanceof AppError && ['CLIENT_TIMEOUT', 'SSE_LIMIT'].includes(e.code))
            deliveryMetrics.slowDisconnects++;
          if (!signal.aborted)
            res.write('event: error\ndata: ' + JSON.stringify(errorResponse(e).error) + '\n\n');
          break;
        }
      }
      res.end();
    } finally {
      await release();
    }
  }
  return server;
}
