import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Application } from '../../application/application.js';
import { errorResponse, requireValue } from '../../shared/errors.js';
import { token } from './request.js';
export function streamJobEvents(
  service: Application,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sockets: Map<string, number>,
) {
  const user = service.auth.principal(token(req));
  const id = url.pathname.split('/')[3] ?? '';
  service.jobFor(user, id);
  const active = sockets.get(user.id) ?? 0;
  requireValue(active < 8, 'SSE_LIMIT', 'Открыто слишком много потоков.', 429);
  sockets.set(user.id, active + 1);
  service.transport.streams++;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  req.socket.setTimeout(0);
  let cursor = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
  let blocked = false;
  let missed = 0;
  let closed = false;
  const release = () => {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    const remaining = Math.max(0, (sockets.get(user.id) ?? 1) - 1);
    if (remaining) sockets.set(user.id, remaining);
    else sockets.delete(user.id);
    service.transport.streams--;
  };
  const poll = () => {
    if (closed) return;
    try {
      requireValue(!service.maintenance, 'MAINTENANCE', 'Выполняется восстановление данных.', 503);
      const current = service.auth.principal(token(req));
      const job = service.jobFor(current, id);
      if (blocked) {
        missed++;
        if (missed > 10 || res.writableLength > 65536) {
          service.transport.slowDisconnects++;
          res.destroy();
        }
        return;
      }
      const row = service.catalog.prepare('SELECT max(seq) AS seq FROM events WHERE job=?').get(id);
      const latest = Number(row?.seq ?? 0);
      if (latest > cursor || cursor === 0) {
        const turn =
          job.kind === 'answer' ? service.catalog.get('turn', String(job.payload.turn)) : undefined;
        const payload = JSON.stringify({ job, turn });
        requireValue(Buffer.byteLength(payload) <= 512000, 'SSE_LIMIT', 'Событие слишком большое.');
        blocked = !res.write(`id: ${latest}\nevent: snapshot\ndata: ${payload}\n\n`);
        service.transport.peakBuffered = Math.max(
          service.transport.peakBuffered,
          res.writableLength,
        );
        cursor = latest;
      } else blocked = !res.write(': heartbeat\n\n');
    } catch (error) {
      const e = errorResponse(error);
      if (!blocked) res.write(`event: error\ndata: ${JSON.stringify(e.error)}\n\n`);
      res.end();
      release();
    }
  };
  res.on('drain', () => {
    blocked = false;
    missed = 0;
  });
  const interval = setInterval(poll, 1000);
  interval.unref();
  res.on('close', release);
  poll();
  return;
}
