import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireValue } from '../../shared/errors.js';
import type { Input } from '../../shared/input.js';
export function token(req: IncomingMessage) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return /(?:^|;\s*)rag_session=([^;]+)/u.exec(req.headers.cookie ?? '')?.[1] ?? '';
}
export const local = (req: IncomingMessage) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
export function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}
export async function body(req: IncomingMessage, limit: number): Promise<Input> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += b.length;
    requireValue(size <= limit, 'REQUEST_LIMIT', 'Превышен размер запроса.', 413);
    chunks.push(b);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    requireValue(false, 'INVALID_JSON', 'Некорректный JSON.');
  }
  requireValue(
    value && typeof value === 'object' && !Array.isArray(value),
    'INVALID_JSON',
    'Ожидается объект JSON.',
  );
  return value as Input;
}
