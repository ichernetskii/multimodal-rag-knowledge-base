import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, open } from 'node:fs/promises';
import { contractSignature } from '../../contracts/format.generated.js';
import type {
  ActionName,
  ActionInputs,
  ActionResults,
  Job,
  UploadSession,
} from '../../contracts/public.js';
import { terminal } from '../../contracts/public.js';
export interface Credentials {
  format: string;
  url: string;
  token: string;
  tenant: string;
}
const sessionFile = () =>
  resolve(process.env.RAG_CLI_FILE ?? resolve(homedir(), '.local/share/local-rag/cli.json'));
export async function credentials() {
  const value = JSON.parse(await readFile(sessionFile(), 'utf8')) as Credentials;
  if (value.format !== contractSignature)
    throw new Error('CLI session belongs to a different format. Sign in again.');
  return value;
}
export async function saveCredentials(value: Credentials) {
  await mkdir(dirname(sessionFile()), { recursive: true, mode: 0o700 });
  await writeFile(sessionFile(), JSON.stringify(value), { mode: 0o600 });
}
export class ApiClient {
  readonly config: Credentials;
  constructor(config: Credentials) {
    this.config = config;
  }
  async request<T>(path: string, input?: unknown, method = 'POST'): Promise<T> {
    const r = await fetch(this.config.url + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + this.config.token,
        'X-Tenant-ID': this.config.tenant,
        ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
      signal: AbortSignal.timeout(120000),
    });
    const result = (await r.json()) as {
      error?: { code: string; message: string; diagnostic: string };
    };
    if (!r.ok)
      throw new Error(
        `${result.error?.code ?? r.status}: ${result.error?.message ?? 'Request failed'} (${result.error?.diagnostic ?? ''})`,
      );
    return result as T;
  }
  action<A extends ActionName>(action: A, input: ActionInputs[A]) {
    return this.request<ActionResults[A]>('/api/actions/' + action, input);
  }
  async upload(
    path: string,
    scope: { collection?: string; conversation?: string; document?: string; revision?: number },
    resume?: string,
  ) {
    const file = await stat(path);
    if (!file.isFile()) throw new Error('Select a regular file.');
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path)) hash.update(bytes as Buffer);
    const sha256 = hash.digest('hex');
    let session = resume
      ? await this.action('uploads.read', { id: resume })
      : await this.action('uploads.create', {
          ...scope,
          name: path.split('/').at(-1)!,
          bytes: file.size,
          sha256,
        });
    if (session.sha256 !== sha256 || session.bytes !== file.size)
      throw new Error('Resume session does not match this file.');
    const handle = await open(path, 'r');
    try {
      while (session.offset < file.size) {
        const buffer = Buffer.alloc(Math.min(session.partBytes, file.size - session.offset));
        const read = await handle.read(buffer, 0, buffer.length, session.offset);
        if (read.bytesRead !== buffer.length) throw new Error('File changed during upload.');
        const r = await fetch(this.config.url + '/api/uploads/' + session.id, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer ' + this.config.token,
            'X-Tenant-ID': this.config.tenant,
            'Upload-Offset': String(session.offset),
            'Content-Type': 'application/octet-stream',
          },
          body: new Uint8Array(buffer),
          signal: AbortSignal.timeout(120000),
        });
        if (!r.ok)
          throw new Error(
            `Upload ${session.id} failed at ${session.offset}; retry with --upload ${session.id}.`,
          );
        session = (await r.json()) as UploadSession;
      }
    } finally {
      await handle.close();
    }
    return this.action('documents.upload', { upload: session.id });
  }
  async wait(
    id: string,
    onSnapshot: (value: { job: Job; turn?: { answer: string } }) => void = () => {},
    timeoutMs = 1800000,
  ) {
    const until = Date.now() + timeoutMs;
    let after = '';
    while (Date.now() < until) {
      const response = await fetch(this.config.url + '/api/events/' + id, {
        headers: {
          Authorization: 'Bearer ' + this.config.token,
          'X-Tenant-ID': this.config.tenant,
          ...(after ? { 'Last-Event-ID': after } : {}),
        },
        signal: AbortSignal.timeout(Math.min(120000, until - Date.now())),
      }).catch(() => null);
      if (!response?.ok || !response.body) {
        const job = await this.action('jobs.read', { id }).catch((e) => {
          if (e instanceof TypeError || e instanceof DOMException) return undefined;
          throw e;
        });
        if (job && terminal.has(job.status)) return job;
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let pending = '';
      try {
        while (true) {
          const read = await reader.read().catch(() => undefined);
          if (!read) break;
          const { value, done } = read;
          pending += decoder.decode(value, { stream: !done });
          let at: number;
          while ((at = pending.indexOf('\n\n')) >= 0) {
            const event = pending.slice(0, at);
            pending = pending.slice(at + 2);
            const data = /^data: (.+)$/mu.exec(event)?.[1];
            const sequence = /^id: (.+)$/mu.exec(event)?.[1];
            if (sequence) after = sequence;
            if (data) {
              const snapshot = JSON.parse(data) as {
                job?: Job;
                turn?: { answer: string };
                code?: string;
                message?: string;
              };
              if (snapshot.code) throw new Error(snapshot.code + ': ' + snapshot.message);
              if (snapshot.job) {
                onSnapshot(snapshot as { job: Job; turn?: { answer: string } });
                if (terminal.has(snapshot.job.status)) return snapshot.job;
              }
            }
          }
          if (done) break;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    throw new Error('Waiting timed out. The job remains saved: ' + id);
  }
}
