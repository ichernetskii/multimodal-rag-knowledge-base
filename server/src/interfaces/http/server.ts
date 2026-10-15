import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { Application } from '../../application/application.js';
import type { User } from '../../domain/entities.js';
import { passwordHash } from '../../features/identity/auth-service.js';
import { errorResponse, requireValue } from '../../shared/errors.js';
import { writeChunk } from './stream-response.js';
import { streamJobEvents } from './event-stream.js';
import { body, local, send, token } from './request.js';

export function createHttpServer(service: Application, options: { recoveryKey?: string } = {}) {
  const sockets = new Map<string, number>();
  let uploads = 0;
  const server = createServer((req, res) => {
    const uploading =
      req.method === 'POST' && req.url?.split('?')[0] === '/api/actions/documents.upload';
    const run = async () => {
      if (uploading) {
        if (uploads >= 2) {
          res.setHeader('Connection', 'close');
          requireValue(
            false,
            'UPLOAD_BUSY',
            'Одновременно принимаются два файла. Повторите загрузку после завершения текущих.',
            429,
          );
        }
        uploads++;
      }
      try {
        await handle(req, res);
      } finally {
        if (uploading) uploads--;
      }
    };
    void run().catch((error) => {
      const e = errorResponse(error);
      if (e.status >= 500) service.catalog.log(e.error.code, e.error.diagnostic);
      if (!res.headersSent) send(res, e.status, { error: e.error });
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.maxConnections = 200;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
    );
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health/live') {
      send(res, 200, { live: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health/ready') {
      const readiness = service.readiness();
      send(res, readiness.ready ? 200 : 503, readiness);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health/dependencies') {
      service.auth.admin(service.auth.principal(token(req)));
      const dependencies = await service.models.health(service.catalog.settings().model);
      send(res, dependencies.embedding && dependencies.generation ? 200 : 503, dependencies);
      return;
    }
    requireValue(!service.maintenance, 'MAINTENANCE', 'Идёт восстановление данных.', 503);
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      const expected =
        process.env.RAG_PUBLIC_ORIGIN ??
        `${process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;
      requireValue(!origin || origin === expected, 'ORIGIN_REJECTED', 'Некорректный Origin.', 403);
      requireValue(
        !req.headers.cookie || origin === expected || Boolean(req.headers.authorization),
        'CSRF_REJECTED',
        'Требуется same-origin запрос.',
        403,
      );
      const upload = url.pathname === '/api/actions/documents.upload';
      if (upload) {
        service.auth.principal(token(req));
        service.data.capacity();
      }
      const limit =
        upload && service.initialized ? service.catalog.settings().maxBytes * 2 + 10000 : 100000;
      requireValue(
        !req.headers['content-length'] || Number(req.headers['content-length']) <= limit,
        'REQUEST_LIMIT',
        'Превышен размер запроса.',
        413,
      );
      const p = await body(req, limit);
      if (url.pathname === '/api/login') {
        const result = await service.auth.login(
          typeof p.login === 'string' ? p.login : '',
          typeof p.password === 'string' ? p.password : '',
          req.socket.remoteAddress ?? '',
        );
        const secure = expected.startsWith('https:');
        res.setHeader(
          'Set-Cookie',
          `rag_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${service.catalog.settings().sessionHours * 3600}${secure ? '; Secure' : ''}`,
        );
        send(res, 200, { user: result.user, ...(p.cli === true ? { token: result.token } : {}) });
        return;
      }
      if (url.pathname === '/api/logout') {
        service.auth.logout(token(req));
        res.setHeader('Set-Cookie', 'rag_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        send(res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/api/recover') {
        const keyPath = join(service.catalog.directory, 'recovery.key');
        const supplied = Buffer.from(token(req));
        const expected = Buffer.from(
          existsSync(keyPath) ? readFileSync(keyPath, 'utf8').trim() : (options.recoveryKey ?? ''),
        );
        requireValue(
          local(req) &&
            !req.headers['x-forwarded-for'] &&
            expected.length > 0 &&
            supplied.length === expected.length &&
            timingSafeEqual(supplied, expected),
          'FORBIDDEN',
          'Восстановление доступно через локальную CLI.',
          403,
        );
        const login = typeof p.login === 'string' ? p.login : '';
        const password = typeof p.password === 'string' ? p.password : '';
        const user = service.catalog.find<User>('user', 'name=?', [login], 'id', 1)[0];
        if (user) {
          const pw = await passwordHash(password);
          const current = service.catalog.get<User>('user', user.id)!;
          current.password = pw;
          current.blocked = false;
          current.role = 'admin';
          current.revision++;
          service.catalog.transaction(() => {
            service.catalog.put('user', current);
            service.auth.revoke(current.id);
          });
        } else {
          requireValue(service.initialized, 'SETUP_REQUIRED', 'Сначала завершите мастер.');
          await service.auth.create(login, password, 'admin');
        }
        send(res, 200, { ok: true });
        return;
      }
      if (url.pathname.startsWith('/api/actions/')) {
        const action = url.pathname.slice('/api/actions/'.length);
        const setup = action.startsWith('setup.');
        if (action === 'setup.create')
          requireValue(
            local(req) && !req.headers['x-forwarded-for'],
            'SETUP_LOCAL_ONLY',
            'Создайте администратора через локальное подключение.',
            403,
          );
        const user = setup ? undefined : service.auth.principal(token(req));
        const result = await service.execute(action, p, user);
        if (
          !setup &&
          ![
            'password.change',
            'sessions.revoke',
            'users.revoke',
            'users.update',
            'backup.restore',
          ].includes(action)
        )
          service.auth.principal(token(req));
        send(res, 200, result);
        return;
      }
    }
    if (req.method === 'GET' && /^\/api\/conversations\/[^/]+\/export$/u.test(url.pathname)) {
      const id = url.pathname.split('/')[3] ?? '';
      await service.readOperation(async (signal) => {
        const exportData = service.exportConversation(service.auth.principal(token(req)), id);
        try {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="conversation-${id.replace(/[^a-zA-Z0-9-]/gu, '')}.json"`,
            'Cache-Control': 'no-store',
          });
          await writeChunk(
            res,
            '{"conversation":' + JSON.stringify(exportData.conversation) + ',"turns":[',
            signal,
          );
          let first = true;
          for (const turn of exportData.turns) {
            service.auth.principal(token(req));
            await writeChunk(res, (first ? '' : ',') + JSON.stringify(turn), signal);
            first = false;
          }
          await writeChunk(
            res,
            '],"exported":' + JSON.stringify(exportData.exported) + '}',
            signal,
          );
          res.end();
        } finally {
          exportData.close();
        }
      });
      return;
    }
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      /^\/api\/documents\/[^/]+$/u.test(url.pathname)
    ) {
      await service.readOperation(async (signal) => {
        const id = url.pathname.split('/')[3] ?? '',
          result = service.original(
            service.auth.principal(token(req)),
            id,
            url.searchParams.get('version') ?? '',
          );
        let start = 0,
          end = result.length - 1;
        const range = req.headers.range;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
          res.setHeader('Content-Range', `bytes */${result.length}`);
          requireValue(
            match && (match[1] || match[2]),
            'INVALID_RANGE',
            'Запрошенный диапазон файла недоступен.',
            416,
          );
          if (match[1]) {
            start = Number(match[1]);
            end = match[2] ? Math.min(Number(match[2]), end) : end;
          } else start = Math.max(0, result.length - Number(match[2]));
          requireValue(
            Number.isSafeInteger(start) &&
              Number.isSafeInteger(end) &&
              start >= 0 &&
              start <= end &&
              start < result.length,
            'INVALID_RANGE',
            'Запрошенный диапазон файла недоступен.',
            416,
          );
          res.setHeader('Content-Range', `bytes ${start}-${end}/${result.length}`);
        }
        res.writeHead(range ? 206 : 200, {
          'Content-Type': result.name.toLowerCase().endsWith('.pdf')
            ? 'application/pdf'
            : 'text/plain; charset=utf-8',
          'Content-Disposition': `${url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(result.name)}`,
          'Cache-Control': 'no-store',
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        while (start <= end && !res.destroyed) {
          requireValue(!service.maintenance, 'MAINTENANCE', 'Выполняется восстановление.', 503);
          const length = Math.min(65536, end - start + 1),
            chunk = service.originalChunk(
              service.auth.principal(token(req)),
              id,
              result.version,
              start,
              length,
            );
          start += length;
          await writeChunk(res, chunk, signal);
        }
        res.end();
      });
      return;
    }
    if (req.method === 'GET' && /^\/api\/events\/[^/]+$/u.test(url.pathname)) {
      streamJobEvents(service, req, res, url, sockets);
      return;
    }
    send(res, 404, {
      error: { code: 'NOT_FOUND', message: 'Маршрут не найден.', diagnostic: randomUUID() },
    });
  }
  return server;
}
