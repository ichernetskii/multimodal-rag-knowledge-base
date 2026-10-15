import type { ActionInputs, ActionName, ActionResults } from './contracts.generated';
interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public diagnostic: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export async function request<T = unknown>(
  path: string,
  input: object = {},
  options: RequestOptions = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000),
    signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(
      timeout.aborted ? 'REQUEST_TIMEOUT' : 'SERVER_UNAVAILABLE',
      timeout.aborted
        ? 'Сервер не ответил вовремя. Повторите запрос.'
        : 'Не удалось подключиться к серверу. Проверьте подключение.',
      '',
      0,
    );
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      'INVALID_RESPONSE',
      'Сервер вернул некорректный ответ.',
      '',
      response.status,
    );
  }
  if (!response.ok) {
    const error = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
    const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
    throw new ApiError(
      typeof record.code === 'string' ? record.code : 'HTTP_ERROR',
      typeof record.message === 'string' ? record.message : 'Ошибка запроса',
      typeof record.diagnostic === 'string' ? record.diagnostic : '',
      response.status,
    );
  }
  return data as T;
}
export function api<A extends ActionName>(
  action: A,
  ...args: Record<string, never> extends ActionInputs[A]
    ? [input?: ActionInputs[A], options?: RequestOptions]
    : [input: ActionInputs[A], options?: RequestOptions]
): Promise<ActionResults[A]> {
  return request<ActionResults[A]>('/api/actions/' + action, args[0] ?? {}, args[1]);
}
export async function base64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let raw = '';
  for (let i = 0; i < bytes.length; i += 8192)
    raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(raw);
}
