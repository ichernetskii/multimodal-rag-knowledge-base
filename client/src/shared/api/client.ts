import type { ActionInputs, ActionName, ActionResults, UploadSession } from './contracts.generated';
interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  tenant?: string;
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
  const selected = options.tenant ?? selectedTenant();
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(selected ? { 'X-Tenant-ID': selected } : {}),
      },
      body: JSON.stringify(input),
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(
      timeout.aborted ? 'REQUEST_TIMEOUT' : 'SERVER_UNAVAILABLE',
      timeout.aborted
        ? 'The server did not respond in time. Try again.'
        : 'Cannot reach the server. Check your connection.',
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
      'The server returned an invalid response.',
      '',
      response.status,
    );
  }
  if (!response.ok) {
    const error = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
    const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
    throw new ApiError(
      typeof record.code === 'string' ? record.code : 'HTTP_ERROR',
      typeof record.message === 'string' ? record.message : 'Request failed',
      typeof record.diagnostic === 'string' ? record.diagnostic : '',
      response.status,
    );
  }
  if (selected !== selectedTenant())
    throw new ApiError('TENANT_CHANGED', 'Company switched.', '', 409);
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

export const selectedTenant = () =>
  typeof sessionStorage === 'undefined' ? '' : (sessionStorage.getItem('rag-tenant') ?? '');
export function tenantUrl(path: string) {
  const tenant = selectedTenant();
  if (!tenant) return path;
  const url = new URL(path, 'http://client.invalid');
  url.searchParams.set('tenant', tenant);
  return url.pathname + url.search + url.hash;
}
export async function uploadFile(
  file: File,
  scope: { collection?: string; conversation?: string; document?: string; revision?: number },
  options: { signal?: AbortSignal; progress?: (done: number, total: number) => void } = {},
) {
  const tenant = selectedTenant(),
    sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
  const key = 'rag-upload:' + tenant + ':' + JSON.stringify(scope) + ':' + sha256;
  let session: UploadSession | undefined;
  const saved = sessionStorage.getItem(key);
  if (saved)
    try {
      session = await api(
        'uploads.read',
        { id: saved },
        { tenant, ...(options.signal ? { signal: options.signal } : {}) },
      );
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
      sessionStorage.removeItem(key);
    }
  if (!session) {
    session = await api(
      'uploads.create',
      { ...scope, name: file.name, bytes: file.size, sha256 },
      { tenant, ...(options.signal ? { signal: options.signal } : {}) },
    );
    sessionStorage.setItem(key, session.id);
  }
  while (session.offset < file.size) {
    if (selectedTenant() !== tenant)
      throw new ApiError('TENANT_CHANGED', 'Company switched.', '', 409);
    options.signal?.throwIfAborted();
    const response = await fetch('/api/uploads/' + session.id, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Tenant-ID': tenant,
        'Upload-Offset': String(session.offset),
      },
      body: file.slice(session.offset, Math.min(file.size, session.offset + session.partBytes)),
      signal: options.signal ?? AbortSignal.timeout(120000),
    });
    const result = (await response.json()) as UploadSession & {
      error?: { code: string; message: string; diagnostic: string };
    };
    if (!response.ok)
      throw new ApiError(
        result.error?.code ?? 'UPLOAD_FAILED',
        result.error?.message ?? 'Could not load this part of the file.',
        result.error?.diagnostic ?? '',
        response.status,
      );
    session = result;
    options.progress?.(session.offset, file.size);
  }
  const result = await api(
    'documents.upload',
    { upload: session.id },
    { tenant, timeoutMs: 120000, ...(options.signal ? { signal: options.signal } : {}) },
  );
  sessionStorage.removeItem(key);
  return result;
}
