import { runInAction } from 'mobx';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationStore } from '../src/app/application-store';
import { conversationBranch } from '../src/features/chat/conversation-branch';
import { api, ApiError } from '../src/shared/api/client';
import type { Conversation, Job, Turn } from '../src/shared/api/contracts.generated';
import { Markdown } from '../src/shared/ui/Markdown';

const conversation: Conversation = {
  id: 'c',
  owner: 'u',
  title: 'Диалог',
  draft: '',
  selected: 'a',
  revision: 1,
  updated: 1,
};
const turn = (id: string, parent = '', replaces = ''): Turn => ({
  id,
  parent,
  replaces,
  conversation: 'c',
  question: id,
  answer: '',
  sources: [],
  status: 'queued',
  job: 'j-' + id,
  created: 1,
  scope: {},
});
const job: Job = {
  id: 'j-a',
  owner: 'u',
  kind: 'answer',
  status: 'generating',
  created: 1,
  updated: 1,
  payload: {},
  result: {},
  error: '',
  diagnostic: '',
  settings: '',
};
beforeEach(() => {
  for (const name of ['localStorage', 'sessionStorage']) {
    const values = new Map<string, string>();
    vi.stubGlobal(name, {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k),
    });
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('conversation versions', () => {
  it('continues the selected version and retains the previous branch', () => {
    const turns = [turn('a'), turn('b', 'a'), turn('a2', '', 'a'), turn('b2', 'a2')];
    expect(conversationBranch(turns, 'b2').map((t) => t.id)).toEqual(['a2', 'b2']);
    expect(conversationBranch(turns, 'b').map((t) => t.id)).toEqual(['a', 'b']);
  });
  it('handles interrupted or cyclic history without looping', () => {
    expect(conversationBranch([turn('a', 'b'), turn('b', 'a')], 'a')).toHaveLength(2);
    expect(conversationBranch([turn('a', 'missing')], 'a')).toHaveLength(1);
  });
  it('serializes draft saves before submitting with the latest revision', async () => {
    const store = new ApplicationStore();
    runInAction(() => {
      store.chat.conversation = { ...conversation };
      store.chat.scope = { collection: 'base-1' };
    });
    const calls: { path: string; data: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, options: RequestInit) => {
        const data = JSON.parse(options.body as string) as Record<string, unknown>;
        calls.push({ path, data });
        const result = path.endsWith('conversations.save')
          ? { ...conversation, draft: data.draft, revision: 2 }
          : path.endsWith('answers.create')
            ? {
                conversation: { ...conversation, revision: 3 },
                turn: turn('b'),
                job: { ...job, status: 'complete' },
              }
            : { items: [], total: 0, page: 1, pageSize: 25 };
        return new Response(JSON.stringify(result), { status: 200 });
      }),
    );
    vi.stubGlobal(
      'EventSource',
      class {
        addEventListener() {}
        close() {}
      },
    );
    store.chat.setDraft('Какой код E-42?');
    await Promise.all([store.chat.flushDraft(), store.chat.flushDraft()]);
    await store.chat.send();
    expect(calls.filter((c) => c.path.endsWith('conversations.save'))).toHaveLength(1);
    expect(calls.find((c) => c.path.endsWith('answers.create'))?.data).toMatchObject({
      revision: 2,
      question: 'Какой код E-42?',
      scope: { collection: 'base-1' },
    });
    expect(store.chat.draft).toBe('');
    expect(localStorage.getItem('rag-draft-c')).toBeNull();
    store.dispose();
  });
  it('restores local draft and reconnects unfinished jobs from the server', async () => {
    const store = new ApplicationStore(),
      urls: string[] = [];
    vi.stubGlobal(
      'EventSource',
      class {
        constructor(url: string) {
          urls.push(url);
        }
        addEventListener() {}
        close() {}
      },
    );
    localStorage.setItem('rag-draft-c', 'Локальный черновик');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              conversation,
              turns: [{ ...turn('a'), scope: { collection: 'base-1', conversation: 'c' } }],
              jobs: [job],
              history: { before: '', hasMore: false },
              variantCounts: { '': 1 },
            }),
          ),
      ),
    );
    await store.chat.openChat('c');
    expect(store.chat.draft).toBe('Локальный черновик');
    expect(store.chat.scope).toEqual({ collection: 'base-1' });
    expect(urls).toEqual(['/api/events/j-a']);
    store.dispose();
  });
});
describe('safe rendering and API boundary', () => {
  it('bounds SSE connections and releases them on terminal snapshots and logout', async () => {
    const streams: FakeStream[] = [];
    class FakeStream extends EventTarget {
      close = vi.fn();
      constructor(public url: string) {
        super();
        streams.push(this);
      }
    }
    vi.stubGlobal('EventSource', FakeStream);
    const store = new ApplicationStore();
    for (let i = 0; i < 12; i++) store.jobs.watch({ ...job, id: 'job-' + i });
    expect(streams).toHaveLength(4);
    streams[0]!.dispatchEvent(
      new MessageEvent('snapshot', {
        data: JSON.stringify({ job: { ...job, id: 'job-0', status: 'complete' } }),
      }),
    );
    await vi.waitFor(() => expect(streams).toHaveLength(5));
    expect(streams[0]!.close).toHaveBeenCalled();
    store.session.signedOut();
    expect(streams.every((stream) => stream.close.mock.calls.length > 0)).toBe(true);
    expect(store.jobs.items).toHaveLength(0);
  });
  it('does not execute document/model HTML or unsafe links and renders tables/code', () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={
          '<script>window.hacked=1</script>\n\n[bad](javascript:alert(1))\n\n| Code | Value |\n| --- | --- |\n| E-42 | 12 |\n\n```html\n<img onerror="alert(1)">\n```'
        }
      />,
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('<table>');
    expect(html).toContain('&lt;img');
  });
  it('keeps citation numbers linked to concrete sources', () => {
    const html = renderToStaticMarkup(
      <Markdown
        text="Ответ [1]."
        sources={[{ id: 1 } as Turn['sources'][number]]}
        onSource={() => undefined}
      />,
    );
    expect(html).toContain('class="citation"');
    expect(html).toContain('[1]');
  });
  it('reports stable server code and diagnostic ID', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'REVISION_CONFLICT', message: 'Конфликт версии', diagnostic: 'diag-1' },
          }),
          { status: 409 },
        ),
    );
    await expect(api('documents.update', { id: 'd', revision: 1 })).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
      status: 409,
      diagnostic: 'diag-1',
    });
    await expect(api('documents.update', { id: 'd', revision: 1 })).rejects.toBeInstanceOf(
      ApiError,
    );
  });
  it('uses same-origin cookies without browser-stored bearer tokens', async () => {
    const fetcher = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetcher);
    await api('me');
    expect(fetcher).toHaveBeenCalledWith(
      '/api/actions/me',
      expect.objectContaining({ credentials: 'same-origin', method: 'POST' }),
    );
  });
});

describe('session isolation', () => {
  it('ignores a conversation response received after logout', async () => {
    const store = new ApplicationStore();
    let complete: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const opening = store.chat.openChat('c');
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    store.session.signedOut();
    complete!(new Response(JSON.stringify({ conversation, turns: [turn('a')], jobs: [job] })));
    await opening;
    expect(store.chat.conversation).toBeNull();
    expect(store.chat.turns).toEqual([]);
    expect(store.jobs.items).toEqual([]);
    store.dispose();
  });
});

describe('state and transport regressions', () => {
  it('keeps immutable server snapshots shallow and ignores superseded conversation lists', async () => {
    const store = new ApplicationStore(),
      requests: ((response: Response) => void)[] = [];
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => requests.push(resolve)));
    const first = store.chat.loadConversations('first'),
      second = store.chat.loadConversations('second');
    requests[1]!(
      new Response(
        JSON.stringify({
          items: [{ ...conversation, id: 'second' }],
          total: 1,
          page: 1,
          pageSize: 25,
        }),
      ),
    );
    await second;
    requests[0]!(
      new Response(
        JSON.stringify({
          items: [{ ...conversation, id: 'first' }],
          total: 1,
          page: 1,
          pageSize: 25,
        }),
      ),
    );
    await first;
    expect(store.chat.conversations[0]!.id).toBe('second');
    const snapshot = turn('immutable');
    runInAction(() => {
      store.chat.conversation = conversation;
    });
    store.chat.receive({ job, turn: snapshot });
    expect(store.chat.turns[0]).toBe(snapshot);
    store.dispose();
  });
  it('keeps the current session after a wrong password in the account form', () => {
    const store = new ApplicationStore();
    runInAction(() => {
      store.session.phase = 'ready';
      store.session.user = {
        id: 'u',
        login: 'reader',
        role: 'user',
        groups: [],
        tenant: 'tenant-a',
        operator: false,
      };
    });
    store.handleError(new ApiError('AUTH_FAILED', 'Wrong password', 'diagnostic', 401), false);
    expect(store.session.phase).toBe('ready');
    store.handleError(new ApiError('UNAUTHENTICATED', 'Session expired', 'diagnostic', 401), false);
    expect(store.session.phase).toBe('login');
    store.dispose();
  });
  it('preserves document streams when switching chats', async () => {
    const streams: { url: string; close: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal(
      'EventSource',
      class {
        close = vi.fn();
        constructor(public url: string) {
          streams.push(this);
        }
        addEventListener() {}
      },
    );
    const store = new ApplicationStore();
    store.jobs.upsert({ ...job, id: 'document-job', kind: 'document' });
    store.jobs.watch({ ...job, id: 'document-job', kind: 'document' });
    store.jobs.upsert(job);
    store.jobs.watch(job);
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            conversation,
            turns: [],
            jobs: [],
            history: { before: '', hasMore: false },
            variantCounts: {},
          }),
        ),
    );
    await store.chat.openChat('c');
    expect(streams.find((s) => s.url.endsWith('document-job'))!.close).not.toHaveBeenCalled();
    expect(streams.find((s) => s.url.endsWith(job.id))!.close).toHaveBeenCalled();
    store.dispose();
  });
});
it('reserves a stream for chat while many documents are queued', () => {
  const streams: string[] = [];
  vi.stubGlobal(
    'EventSource',
    class {
      constructor(url: string) {
        streams.push(url);
      }
      addEventListener() {}
      close() {}
    },
  );
  const store = new ApplicationStore();
  for (let index = 0; index < 12; index++)
    store.jobs.watch({ ...job, id: 'document-' + index, kind: 'document' });
  expect(streams).toHaveLength(3);
  store.jobs.watch(job);
  expect(streams).toHaveLength(4);
  expect(streams.at(-1)).toContain(job.id);
  store.dispose();
});
