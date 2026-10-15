import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
  type IncomingHttpHeaders,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { httpOrigin } from './config.ts';
const defaultDirectory = fileURLToPath(new URL('../dist/', import.meta.url));
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const security = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
};
const hopHeaders = [
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
];
function headersWithoutHop(headers: IncomingHttpHeaders) {
  const out = { ...headers },
    connection = String(out.connection ?? '')
      .toLowerCase()
      .split(',')
      .map((name) => name.trim());
  for (const name of [...hopHeaders, ...connection]) delete out[name];
  return out;
}
function error(res: ServerResponse, status: number, code: string, message: string) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.removeHeader('Content-Length');
  res.removeHeader('Content-Encoding');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...security,
  });
  res.end(JSON.stringify({ error: { code, message, diagnostic: randomUUID() } }));
}
function acceptedEncodings(value: string) {
  return new Map(
    value
      .toLowerCase()
      .split(',')
      .map((item) => {
        const [name, ...parameters] = item.trim().split(';'),
          quality = parameters.find((part) => part.trim().startsWith('q='));
        return [name ?? '', quality ? Number(quality.trim().slice(2)) : 1] as const;
      }),
  );
}
/** A standalone production client. Streaming pipes propagate backpressure; the API may be offline. */
export function createClientServer(options: { apiUrl: string; directory?: string }) {
  const target = new URL(httpOrigin(options.apiUrl, 'CLIENT_API_URL')),
    directory = realpathSync(options.directory ?? defaultDirectory);
  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      error(res, 500, 'ASSET_ERROR', 'Не удалось прочитать файл клиента.');
    }
  });
  function handle(req: IncomingMessage, res: ServerResponse) {
    for (const [key, value] of Object.entries(security)) res.setHeader(key, value);
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://client');
    } catch {
      error(res, 400, 'INVALID_URL', 'Некорректный адрес.');
      return;
    }
    if (url.pathname === '/_client/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end('{"live":true}');
      return;
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/health/')) {
      proxy(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      error(res, 405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается.');
      return;
    }
    let candidate: string;
    try {
      candidate = resolve(directory, '.' + decodeURIComponent(url.pathname));
    } catch {
      error(res, 400, 'INVALID_URL', 'Некорректный адрес.');
      return;
    }
    if (candidate !== directory && !candidate.startsWith(directory + sep)) {
      error(res, 404, 'NOT_FOUND', 'Файл не найден.');
      return;
    }
    let asset =
      existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : !extname(url.pathname) && !url.pathname.startsWith('/assets/')
          ? resolve(directory, 'index.html')
          : '';
    if (!asset || !existsSync(asset) || !realpathSync(asset).startsWith(directory + sep)) {
      error(res, 404, 'NOT_FOUND', 'Файл не найден.');
      return;
    }
    const mime = types[extname(asset)] ?? 'application/octet-stream',
      accepted = acceptedEncodings(String(req.headers['accept-encoding'] ?? ''));
    let compressed = '';
    for (const name of ['br', 'gzip'] as const) {
      const quality = accepted.get(name) ?? accepted.get('*') ?? 0,
        extension = name === 'br' ? '.br' : '.gz';
      if (quality > 0 && existsSync(asset + extension)) {
        asset += extension;
        compressed = name;
        break;
      }
    }
    const info = statSync(asset),
      etag = '"' + info.size.toString(16) + '-' + Math.floor(info.mtimeMs).toString(16) + '"';
    res.setHeader('ETag', etag);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader(
      'Cache-Control',
      asset.includes(sep + 'assets' + sep) ? 'public, max-age=31536000, immutable' : 'no-cache',
    );
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', info.size);
    if (compressed) res.setHeader('Content-Encoding', compressed);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(asset);
    stream.on('error', () => error(res, 500, 'ASSET_ERROR', 'Не удалось прочитать файл.'));
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
  function proxy(req: IncomingMessage, res: ServerResponse, url: URL) {
    const headers = headersWithoutHop(req.headers);
    for (const name of Object.keys(headers))
      if (name.startsWith('x-forwarded-')) delete headers[name];
    const peer = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) headers['x-forwarded-for'] = peer;
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest,
      upstream = send(
        new URL(url.pathname + url.search, target),
        { method: req.method, headers },
        (incoming) => {
          res.writeHead(incoming.statusCode ?? 502, headersWithoutHop(incoming.headers));
          incoming.pipe(res);
          incoming.on('error', () => res.destroy());
          res.on('close', () => incoming.destroy());
        },
      );
    upstream.setTimeout(660_000, () => upstream.destroy(new Error('Upstream timeout')));
    upstream.on('error', () =>
      error(res, 502, 'SERVER_UNAVAILABLE', 'Сервер приложения недоступен. Повторите подключение.'),
    );
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.maxConnections = 200;
  return server;
}
