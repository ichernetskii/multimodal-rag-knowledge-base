import { afterEach, expect, it, vi } from 'vitest';
import { JobStreamStore } from '../src/features/jobs/job-stream-store';
import type { Job } from '../src/shared/api/contracts.generated';
const job = (id: string, kind: Job['kind'] = 'document'): Job => ({
  id,
  kind,
  owner: 'u',
  status: 'queued',
  created: 1,
  updated: 1,
  payload: {},
  result: {},
  error: '',
  diagnostic: '',
  settings: '',
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('coordinates four SSE sockets across tabs and keeps a global slot outside document indexing', async () => {
  const held = new Set<string>(),
    active = new Map<string, { close: () => void }>();
  let peak = 0;
  const locks = {
    async request(
      name: string,
      _options: unknown,
      callback: (lock: { name: string } | null) => unknown,
    ) {
      await Promise.resolve();
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
  vi.stubGlobal('navigator', { locks });
  vi.stubGlobal('window', {});
  vi.stubGlobal(
    'EventSource',
    class {
      constructor(public url: string) {
        active.set(url, this);
        peak = Math.max(peak, active.size);
      }
      addEventListener() {}
      close() {
        active.delete(this.url);
      }
    },
  );
  const first = new JobStreamStore(
      () => {},
      () => {},
    ),
    second = new JobStreamStore(
      () => {},
      () => {},
    );
  try {
    for (let index = 0; index < 12; index++) {
      first.watch(job('first-' + index));
      second.watch(job('second-' + index));
    }
    second.watch(job('answer', 'answer'));
    await vi.waitFor(() => expect(active.size).toBe(4));
    expect([...active.keys()].some((url) => url.endsWith('/answer'))).toBe(true);
    expect([...active.keys()].filter((url) => !url.endsWith('/answer'))).toHaveLength(3);
    expect(peak).toBe(4);
    first.reset();
    await vi.waitFor(() =>
      expect([...active.keys()].every((url) => !url.includes('/first-'))).toBe(true),
    );
    expect(peak).toBe(4);
  } finally {
    first.reset();
    second.reset();
  }
  await vi.waitFor(() => expect(held.size).toBe(0));
  expect(active.size).toBe(0);
});
it('does not reconnect a job rejected by access control until the workspace is reset', () => {
  const streams: {
    listeners: Map<string, (event: { data: string }) => void>;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal(
    'EventSource',
    class {
      listeners = new Map();
      close = vi.fn();
      constructor() {
        streams.push(this);
      }
      addEventListener(name: string, callback: (event: { data: string }) => void) {
        this.listeners.set(name, callback);
      }
    },
  );
  const error = vi.fn(),
    store = new JobStreamStore(() => {}, error);
  store.watch(job('answer', 'answer'));
  streams[0]!.listeners.get('error')!({
    data: JSON.stringify({ code: 'ACCESS_REVOKED', message: 'Access revoked' }),
  });
  store.watch(job('answer', 'answer'));
  expect(streams).toHaveLength(1);
  expect(streams[0]!.close).toHaveBeenCalledOnce();
  expect(error).toHaveBeenCalledOnce();
  store.reset();
  store.watch(job('answer', 'answer'));
  expect(streams).toHaveLength(2);
  store.reset();
});
