import { existsSync, readFileSync, createWriteStream } from 'node:fs';
import { link, rm } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { serverPath } from '../../config/paths.js';
import { integer } from '../../config/app-config.js';
import { AppError, requireValue } from '../../shared/errors.js';

export function dataDirectory() {
  const initial = serverPath(process.env.RAG_DATA_DIR ?? 'data'),
    location = join(initial, 'data-location.json');
  return existsSync(location)
    ? resolve((JSON.parse(readFileSync(location, 'utf8')) as { directory: string }).directory)
    : initial;
}
export const sessionPath = () => join(dataDirectory(), '.cli-session');
export function apiOrigin() {
  let url: URL;
  try {
    url = new URL(
      process.env.RAG_URL ?? `http://127.0.0.1:${integer(process.env, 'RAG_PORT', 3210, 1, 65535)}`,
    );
  } catch {
    throw new AppError('INVALID_CONFIG', 'RAG_URL: укажите HTTP(S) origin сервера.');
  }
  requireValue(
    ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash,
    'INVALID_CONFIG',
    'RAG_URL: укажите HTTP(S) origin без пути, пароля и параметров.',
  );
  return url;
}
function sessionToken() {
  return (
    process.env.RAG_TOKEN ??
    (existsSync(sessionPath()) ? readFileSync(sessionPath(), 'utf8').trim() : '')
  );
}
async function request(
  path: string,
  options: { input?: Record<string, unknown>; token?: string; timeout?: number } = {},
) {
  const token = options.token ?? sessionToken();
  let response: Response;
  try {
    response = await fetch(new URL(path, apiOrigin()), {
      method: options.input ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeout ?? 30_000),
      headers: {
        ...(options.input ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      ...(options.input ? { body: JSON.stringify(options.input) } : {}),
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      error instanceof Error && error.name === 'TimeoutError'
        ? 'REQUEST_TIMEOUT'
        : 'SERVER_UNAVAILABLE',
      'Сервер недоступен или не успел ответить. Проверьте RAG_URL и состояние службы.',
      503,
    );
  }
  if (!response.ok) {
    let error: { code?: string; message?: string; diagnostic?: string } = {};
    try {
      error = ((await response.json()) as { error?: typeof error }).error ?? {};
    } catch {
      /* A reverse proxy can return a non-JSON error. */
    }
    throw new AppError(
      error.code ?? 'HTTP_ERROR',
      error.message ?? `Ошибка HTTP ${response.status}.`,
      response.status,
      error.diagnostic,
    );
  }
  return response;
}
export async function api(
  action: string,
  input: Record<string, unknown>,
  token?: string,
): Promise<unknown> {
  const response = await request(action.startsWith('/') ? action : '/api/actions/' + action, {
    input,
    ...(token === undefined ? {} : { token }),
    timeout: [
      'backup.create',
      'backup.restore',
      'backup.verify',
      'sync.preview',
      'sync.run',
      'documents.upload',
      'diagnostics',
    ].includes(action)
      ? 600_000
      : 30_000,
  });
  try {
    return await response.json();
  } catch {
    throw new AppError('INVALID_RESPONSE', 'Сервер вернул некорректный JSON.', 502);
  }
}
export async function download(path: string, output: string) {
  const response = await request(path, { timeout: 600_000 });
  requireValue(response.body, 'EMPTY_RESPONSE', 'Сервер не вернул файл.', 502);
  const reader = response.body.getReader();
  async function* chunks() {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) return;
        yield part.value;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  const target = resolve(output),
    temporary = join(dirname(target), '.' + basename(target) + '.' + randomUUID() + '.partial');
  try {
    await pipeline(
      Readable.from(chunks()),
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
    );
    await link(temporary, target);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new AppError('FILE_EXISTS', 'Файл назначения уже существует. Укажите другое имя.', 409);
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
    await rm(temporary, { force: true });
  }
  return target;
}
