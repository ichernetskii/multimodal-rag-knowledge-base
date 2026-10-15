import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Application } from '../src/application/application.js';
import type { ModelRuntime } from '../src/application/ports/model-runtime.js';
import { defaults } from '../src/config/default-settings.js';
import type {
  Collection,
  Conversation,
  DocumentRecord,
  Job,
  Principal,
  Settings,
  Source,
  Turn,
  User,
  Version,
} from '../src/domain/entities.js';
import { terminal } from '../src/domain/entities.js';
import { restoreInstallation } from '../src/features/backup/backup-service.js';
import { Catalog } from '../src/infrastructure/database/catalog.js';
import { createHttpServer } from '../src/interfaces/http/server.js';
import type { Input } from '../src/shared/input.js';

class TestModels implements ModelRuntime {
  calls = 0;
  histories: { role: 'user' | 'assistant'; content: string }[][] = [];
  async signature() {
    return 'test-model-v1';
  }
  async query() {
    return [1, 0, 0];
  }
  async index(_name: string, pages: Version['pages'], signal: AbortSignal) {
    signal.throwIfAborted();
    return pages.flatMap((p) =>
      p.sections.map((s) => ({
        page: p.number,
        section: s.title,
        body: s.text,
        vector: [1, 0, 0],
      })),
    );
  }
  async generate(
    q: string,
    s: Source[],
    history: { role: 'user' | 'assistant'; content: string }[],
    _settings: Settings,
    signal: AbortSignal,
    onToken: (token: string) => void,
  ) {
    this.calls++;
    this.histories.push(history);
    if (q.includes('slow'))
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2000);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    signal.throwIfAborted();
    const answer = s[0]!.text + ' [1]';
    onToken(answer);
    return { answer, insufficient: false };
  }
  async health() {
    return { embedding: true, generation: true, indexSignature: 'test-model-v1', models: ['test'] };
  }
  async close() {}
}
async function fixture(t: test.TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'rag-product-'));
  const model = new TestModels();
  const service = new Application(
    new Catalog(path),
    model,
    defaults(path, 'test', 'Use sources only'),
  );
  t.after(async () => {
    await service.close();
    rmSync(path, { recursive: true, force: true });
  });
  await service.execute('setup.create', { login: 'admin', password: 'safe-admin-pass' });
  const admin = service.catalog.list<User>('user')[0]!;
  const a = service.auth.current(admin.id);
  const exec = <T>(action: string, input: Input = {}, user: Principal = a) =>
    service.execute(action, input, user) as Promise<T>;
  const user = await exec<Principal>('users.create', {
    login: 'operator',
    password: 'safe-user-pass',
    role: 'user',
  });
  const editor = await exec<Principal>('users.create', {
    login: 'editor',
    password: 'safe-editor-pass',
    role: 'editor',
  });
  const collection = await exec<Collection>('collections.save', {
    name: 'Manuals',
    grants: [
      { subject: user.id, access: 'read' },
      { subject: editor.id, access: 'edit' },
    ],
  });
  service.start();
  return { service, model, exec, user, editor, admin: a, collection, path };
}
async function wait(service: Application, id: string) {
  for (let i = 0; i < 500; i++) {
    const job = service.catalog.get<Job>('job', id)!;
    if (terminal.has(job.status)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job timeout');
}
async function upload(
  f: Awaited<ReturnType<typeof fixture>>,
  body = 'E-42 torque is 12 Nm',
  p: Input = {},
) {
  const r = await f.exec<{ document: DocumentRecord; version: Version; job: Job }>(
    'documents.upload',
    {
      collection: f.collection.id,
      name: 'manual.md',
      base64: Buffer.from('# Safety\n' + body).toString('base64'),

      ...p,
    },
  );
  assert.equal((await wait(f.service, r.job.id)).status, 'complete');
  return f.service.catalog.get<DocumentRecord>('document', r.document.id)!;
}
async function answer(
  f: Awaited<ReturnType<typeof fixture>>,
  c: Conversation,
  q = 'What is E-42?',
  p: Input = {},
) {
  const r = await f.exec<{ turn: Turn; job: Job; conversation: Conversation }>(
    'answers.create',
    {
      conversation: c.id,
      revision: c.revision,
      question: q,
      scope: {},
      ...p,
    },
    f.user,
  );
  await wait(f.service, r.job.id);
  return {
    turn: f.service.catalog.get<Turn>('turn', r.turn.id)!,
    conversation: f.service.catalog.get<Conversation>('conversation', c.id)!,
    job: f.service.catalog.get<Job>('job', r.job.id)!,
  };
}

void test('ACL applies to retrieval, sources, history, results, cache and live roles', async (t) => {
  const f = await fixture(t);
  const d = await upload(f);
  const hits = await f.exec<Source[]>('search', { question: 'E-42' }, f.user);
  assert.equal(hits[0]?.document, d.id);
  const c = await f.exec<Conversation>('conversations.create', {}, f.user);
  const result = await answer(f, c);
  assert.equal(result.turn.status, 'complete');
  const newCollection = await f.exec<Collection>('collections.save', {
    id: f.collection.id,
    revision: f.collection.revision,
    name: 'Manuals',
    grants: [],
  });
  assert.equal(newCollection.revision, 2);
  assert.deepEqual(await f.exec('search', { question: 'E-42' }, f.user), []);
  await assert.rejects(f.exec('documents.read', { id: d.id }, f.user), /доступ/iu);
  assert.throws(() => f.service.jobFor(f.user, result.job.id), /отозван/iu);
  const read = await f.exec<{ turns: (Turn & { redacted?: boolean })[] }>(
    'conversations.read',
    { id: c.id },
    f.user,
  );
  assert.equal(read.turns[0]?.redacted, true);
  assert.equal(read.turns[0]?.sources.length, 0);
  const exportData = f.service.exportConversation(f.user, c.id);
  const exported = { turns: [...exportData.turns] };
  exportData.close();
  assert.ok(!exported.turns[0]?.answer.includes('12 Nm'));
  await assert.rejects(
    f.exec(
      'documents.upload',
      { collection: f.collection.id, name: 'x.txt', base64: 'eA==' },
      f.user,
    ),
    /доступ/iu,
  );
});
void test('sessions are hashed, blocking and group changes take effect immediately', async (t) => {
  const f = await fixture(t);
  const login = await f.service.auth.login('operator', 'safe-user-pass', 'local');
  assert.equal(f.service.auth.principal(login.token).id, f.user.id);
  assert.notEqual(
    f.service.catalog.db.prepare('SELECT token FROM sessions').get()?.token,
    login.token,
  );
  const group = await f.exec<{ id: string }>('groups.save', { name: 'Workshop' });
  const u = f.service.catalog.get<User>('user', f.user.id)!;
  await f.exec('users.update', {
    id: u.id,
    revision: u.revision,
    groups: [group.id],
    blocked: false,
  });
  assert.throws(() => f.service.auth.principal(login.token), /Войдите/iu);
  const logged = await f.service.auth.login('operator', 'safe-user-pass', 'local');
  const current = f.service.catalog.get<User>('user', u.id)!;
  await f.exec('users.update', { id: u.id, revision: current.revision, blocked: true });
  assert.throws(() => f.service.auth.principal(logged.token), /Войдите/iu);
  await assert.rejects(f.service.auth.login('operator', 'safe-user-pass', 'local'), /Неверный/iu);
});
void test('versions preserve provenance, hashes survive rename, optimistic conflicts and restoration', async (t) => {
  const f = await fixture(t);
  let d = await upload(f);
  const old = d.activeVersion;
  d = await f.exec<DocumentRecord>('documents.update', {
    id: d.id,
    revision: d.revision,
    name: 'renamed.md',
  });
  const duplicate = await f.exec<{ duplicate: string }>('documents.upload', {
    collection: f.collection.id,
    name: 'another.md',
    base64: Buffer.from('# Safety\nE-42 torque is 12 Nm').toString('base64'),
  });
  assert.equal(duplicate.duplicate, d.id);
  await assert.rejects(
    f.exec('documents.update', { id: d.id, revision: d.revision - 1, name: 'overwrite' }),
    /изменена/iu,
  );
  const updated = await upload(f, 'E-42 torque is 18 Nm', {
    document: d.id,
    revision: d.revision,
    name: 'renamed.md',
  });
  assert.notEqual(updated.activeVersion, old);
  const oldSource = await f.exec<{ version: Version }>(
    'documents.read',
    { id: d.id, version: old },
    f.user,
  );
  assert.ok(oldSource.version.pages[0]?.text.includes('12 Nm'));
  const restored = await f.exec<DocumentRecord>('documents.restore', {
    id: d.id,
    revision: updated.revision,
    version: old,
  });
  assert.equal(restored.activeVersion, old);
  const compare = await f.exec<{ left: Version['pages']; right: Version['pages'] }>(
    'documents.compare',
    { id: d.id, left: old, right: updated.activeVersion },
  );
  assert.notDeepEqual(compare.left, compare.right);
});
void test('chat edits/regeneration form immutable branches, drafts persist and follow-up uses selected history', async (t) => {
  const f = await fixture(t);
  await upload(f);
  let c = await f.exec<Conversation>('conversations.create', {}, f.user);
  c = await f.exec<Conversation>(
    'conversations.save',
    { id: c.id, revision: c.revision, draft: 'pending draft' },
    f.user,
  );
  assert.equal(
    (await f.exec<{ conversation: Conversation }>('conversations.read', { id: c.id }, f.user))
      .conversation.draft,
    'pending draft',
  );
  const first = await answer(f, c);
  const second = await answer(f, first.conversation, 'What is E-42? edited', {
    replaces: first.turn.id,
  });
  assert.equal(second.turn.parent, first.turn.parent);
  assert.equal(second.turn.replaces, first.turn.id);
  assert.equal(f.service.catalog.get<Turn>('turn', first.turn.id)?.answer, first.turn.answer);
  const third = await answer(f, second.conversation, 'E-42 follow-up');
  assert.equal(third.turn.parent, second.turn.id);
  assert.equal(f.model.histories.at(-1)?.[0]?.content, second.turn.question);
  assert.notEqual(f.model.histories.at(-1)?.[0]?.content, first.turn.question);
});
void test('private attachments stay scoped and exact punctuation survives retrieval', async (t) => {
  const f = await fixture(t);
  const d = await upload(f);
  const c = await f.exec<Conversation>('conversations.create', {}, f.user);
  const attached = await f.exec<{ document: DocumentRecord; job: Job }>(
    'documents.upload',
    {
      conversation: c.id,
      name: 'private.txt',
      base64: Buffer.from('PRIVATE E+99 procedure and instructions').toString('base64'),
    },
    f.user,
  );
  await wait(f.service, attached.job.id);
  assert.deepEqual(await f.exec('search', { question: 'E+99' }, f.editor), []);
  assert.deepEqual(await f.exec('search', { question: 'E+99' }, f.user), []);
  assert.equal(
    (
      await f.exec<Source[]>('search', { question: 'E+99', scope: { conversation: c.id } }, f.user)
    )[0]?.document,
    attached.document.id,
  );
  await assert.rejects(f.exec('documents.read', { id: attached.document.id }), /владельцу/iu);
  assert.equal(
    (
      await f.exec<Source[]>(
        'search',
        { question: 'E+99', scope: { collection: f.collection.id, conversation: c.id } },
        f.user,
      )
    )[0]?.document,
    attached.document.id,
  );
  assert.ok((await f.exec<Source[]>('search', { question: 'E-42' }, f.user)).length > 0);
  assert.equal(
    (await f.exec<Source[]>('search', { question: 'E-42', scope: {} }, f.user))[0]?.document,
    d.id,
  );
});
void test('generic documents answer directly and unsupported input fields are rejected', async (t) => {
  const f = await fixture(t);
  await upload(f, 'Project approval takes 3 working days.');
  const c = await f.exec<Conversation>('conversations.create', {}, f.user);
  const result = await answer(f, c, 'How long does project approval take?');
  assert.equal(result.turn.status, 'complete');
  assert.equal(f.model.calls, 1);
  await assert.rejects(
    f.exec('documents.upload', {
      collection: f.collection.id,
      name: 'legacy.txt',
      base64: Buffer.from('legacy').toString('base64'),
      metadata: { manufacturer: 'legacy' },
    }),
    /неподдерживаемые/iu,
  );
  await assert.rejects(
    f.exec('search', { question: 'approval', scope: { model: 'legacy' } }, f.user),
    /неподдерживаемые/iu,
  );
});
void test('backup integrity, independent restore and live restore preserve completed jobs and revoke sessions', async (t) => {
  const f = await fixture(t);
  await upload(f);
  const c = await f.exec<Conversation>('conversations.create', {}, f.user);
  const completed = await answer(f, c);
  const backup = await f.exec<{ id: string }>('backup.create');
  const verified = await f.exec<{ integrity: string }>('backup.verify', { id: backup.id });
  assert.equal(verified.integrity, 'ok');
  const target = join(f.path, 'other-installation');
  const report = await restoreInstallation(
    join(f.service.catalog.settings().backupDir, backup.id),
    target,
  );
  assert.ok(report.milliseconds >= 0);
  const restored = new Catalog(target);
  try {
    assert.equal(restored.get<Job>('job', completed.job.id)?.status, 'complete');
    assert.equal(restored.get<Turn>('turn', completed.turn.id)?.answer, completed.turn.answer);
    assert.equal(restored.list<Version>('version').length, 1);
  } finally {
    restored.close();
  }
  const session = await f.service.auth.login('operator', 'safe-user-pass', 'local');
  await f.exec('backup.restore', { id: backup.id });
  assert.throws(() => f.service.auth.principal(session.token), /Войдите/iu);
  assert.equal(f.service.catalog.get<Job>('job', completed.job.id)?.status, 'complete');
  assert.equal(f.service.catalog.settings().dataDir, f.path);
});
void test('folder sync previews changes, retains IDs on rename and applies explicit deletion policy', async (t) => {
  const f = await fixture(t);
  const directory = join(f.path, 'folder');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(directory);
  writeFileSync(join(directory, 'one.txt'), 'E-55 manual instructions');
  const sync = await f.exec<{ id: string }>('sync.save', {
    path: directory,
    collection: f.collection.id,
    policy: 'exclude',
    intervalMinutes: 0,
  });
  let preview = await f.exec<{ files: { status: string }[] }>('sync.preview', { id: sync.id });
  assert.equal(preview.files[0]?.status, 'new');
  await f.exec('sync.run', { id: sync.id });
  const job = f.service.catalog.list<Job>('job').find((j) => j.kind === 'document')!;
  await wait(f.service, job.id);
  const doc = f.service.catalog.list<DocumentRecord>('document')[0]!;
  renameSync(join(directory, 'one.txt'), join(directory, 'renamed.txt'));
  await f.exec('sync.run', { id: sync.id });
  assert.equal(f.service.catalog.list<DocumentRecord>('document').length, 1);
  rmSync(join(directory, 'renamed.txt'));
  preview = await f.exec('sync.preview', { id: sync.id });
  assert.ok(preview.files.some((f) => f.status === 'removed'));
  await f.exec('sync.run', { id: sync.id });
  assert.equal(f.service.catalog.get<DocumentRecord>('document', doc.id)?.state, 'excluded');
});
void test('resource controls and cancelled jobs keep durable partial state, cleanup protects active work', async (t) => {
  const f = await fixture(t);
  await upload(f);
  const settings = f.service.catalog.settings();
  await f.exec('settings.save', { revision: settings.revision, settings: { pauseQueue: true } });
  const c = await f.exec<Conversation>('conversations.create', {}, f.user);
  const result = await f.exec<{ job: Job }>(
    'answers.create',
    { conversation: c.id, revision: c.revision, question: 'slow E-42' },
    f.user,
  );
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(f.service.catalog.get<Job>('job', result.job.id)?.status, 'queued');
  await f.exec('cleanup');
  assert.ok(f.service.catalog.get<Job>('job', result.job.id));
  await f.exec('jobs.cancel', { id: result.job.id }, f.user);
  assert.equal(f.service.catalog.get<Job>('job', result.job.id)?.status, 'cancelled');
  const newer = f.service.catalog.settings();
  await f.exec('settings.save', { revision: newer.revision, settings: { pauseIntake: true } });
  await assert.rejects(
    f.exec(
      'answers.create',
      { conversation: c.id, revision: c.revision + 1, question: 'E-42' },
      f.user,
    ),
    /приостановлен/iu,
  );
});
void test('HTTP cookies, CSRF, SSE snapshots, revocation and health are enforced', async (t) => {
  const f = await fixture(t);
  await upload(f);
  const server = createHttpServer(f.service);
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = 'http://127.0.0.1:' + address.port;
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const session = await f.service.auth.login('operator', 'safe-user-pass', 'local');
  const headers = { Authorization: 'Bearer ' + session.token, 'Content-Type': 'application/json' };
  const denied = await fetch(url + '/api/actions/users.list', {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.equal(denied.status, 403);
  const cross = await fetch(url + '/api/actions/conversations.create', {
    method: 'POST',
    headers: { ...headers, Origin: 'https://evil.example' },
    body: '{}',
  });
  assert.equal(cross.status, 403);
  const c = await f.exec<Conversation>('conversations.create', {}, f.user);
  const answerResult = await answer(f, c);
  const response = await fetch(url + '/api/events/' + answerResult.job.id, { headers });
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body!.getReader();
  const part = await reader.read();
  assert.match(new TextDecoder().decode(part.value), /event: snapshot/u);
  f.service.auth.revoke(f.user.id);
  const next = await reader.read();
  assert.match(new TextDecoder().decode(next.value), /UNAUTHENTICATED/u);
  await reader.cancel();
  assert.equal((await fetch(url + '/health/live')).status, 200);
});

void test('SSE traverses a reverse proxy, multiple tabs and an unread client with bounded buffers', async (t) => {
  const f = await fixture(t);
  const { createServer, request } = await import('node:http');
  const { createConnection } = await import('node:net');
  const server = createHttpServer(f.service);
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const proxy = createServer((req, res) => {
    const upstream = request(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (incoming) => {
        res.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(res);
        res.on('close', () => incoming.destroy());
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
    res.on('close', () => upstream.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await new Promise<void>((r) => proxy.once('listening', r));
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress !== 'string');
  t.after(() => {
    proxy.closeAllConnections();
    proxy.close();
    server.closeAllConnections();
    server.close();
  });
  const session = await f.service.auth.login('operator', 'safe-user-pass', 'proxy');
  const c = await f.exec<Conversation>('conversations.create', {}, f.user);
  const turn: Turn = {
    id: 'transport-turn',
    conversation: c.id,
    parent: '',
    replaces: '',
    question: 'test',
    answer: 'x'.repeat(90000),
    sources: [],
    status: 'generating',
    job: 'transport-job',
    created: Date.now(),
    scope: {},
  };
  const job: Job = {
    id: turn.job,
    owner: f.user.id,
    kind: 'answer',
    status: 'generating',
    created: Date.now(),
    updated: Date.now(),
    payload: { turn: turn.id, conversation: c.id },
    result: {},
    error: '',
    diagnostic: '',
    settings: '{}',
  };
  f.service.catalog.put('turn', turn);
  f.service.catalog.put('job', job);
  const headers = { Authorization: 'Bearer ' + session.token };
  const responses = await Promise.all([
    fetch(`http://127.0.0.1:${proxyAddress.port}/api/events/${job.id}`, { headers }),
    fetch(`http://127.0.0.1:${proxyAddress.port}/api/events/${job.id}`, { headers }),
  ]);
  const readers = responses.map((r) => r.body!.getReader());
  for (const [index, reader] of readers.entries()) {
    assert.equal(responses[index]?.headers.get('x-accel-buffering'), 'no');
    const event = await reader.read();
    assert.match(new TextDecoder().decode(event.value), /event: snapshot/u);
  }
  const slow = createConnection({ host: '127.0.0.1', port: address.port });
  slow.on('error', () => {});
  slow.write(
    `GET /api/events/${job.id} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${session.token}\r\n\r\n`,
  );
  slow.pause();
  t.after(() => slow.destroy());
  const timer = setInterval(
    () =>
      f.service.catalog.db
        .prepare('INSERT INTO events(job,created,body) VALUES (?,?,?)')
        .run(job.id, Date.now(), '{}'),
    200,
  );
  await new Promise((r) => setTimeout(r, 3200));
  clearInterval(timer);
  assert.ok(f.service.transport.peakBuffered > 0);
  assert.ok(f.service.transport.peakBuffered < 201000);
  assert.ok(f.service.transport.streams <= 3);
  for (const reader of readers) await reader.cancel();
  slow.destroy();
});

void test('writer lock and corrupt restores leave the original installation intact', async (t) => {
  const f = await fixture(t);
  await upload(f);
  const backup = await f.exec<{ id: string }>('backup.create');
  assert.throws(() => new Catalog(f.path), /занят/iu);
  const path = join(f.service.catalog.settings().backupDir, backup.id);
  writeFileSync(path + '.sha256', '0'.repeat(64));
  await assert.rejects(f.exec('backup.restore', { id: backup.id }), /сумма/iu);
  assert.equal(f.service.catalog.list('document').length, 1);
  await assert.rejects(restoreInstallation(path, join(f.path, 'bad-restore')), /сумма/iu);
});

void test('preview warns about document count and publication cannot acknowledge missing pages', async (t) => {
  const f = await fixture(t);
  const d = await upload(f);
  const v = f.service.catalog.get<Version>('version', d.activeVersion)!;
  v.state = 'review';
  v.pages.push({ number: 2, text: '', method: 'ocr', warnings: ['NO_TEXT'], sections: [] });
  f.service.catalog.put('version', v);
  await assert.rejects(
    f.exec('documents.publish', {
      id: d.id,
      revision: d.revision,
      version: v.id,
      acknowledge: true,
    }),
    /текст/iu,
  );
  const settings = f.service.catalog.settings();
  await f.exec('settings.save', { revision: settings.revision, settings: { maxDocuments: 1 } });
  const preview = await f.exec<{ status: string }[]>('documents.preview', {
    collection: f.collection.id,
    files: [{ name: 'new.txt', bytes: 10, hash: '0'.repeat(64) }],
  });
  assert.equal(preview[0]?.status, 'limit');
});

void test('feedback reasons and quality dimensions persist source versions without changing knowledge', async (t) => {
  const f = await fixture(t),
    d = await upload(f),
    c = await f.exec<Conversation>('conversations.create', {}, f.user);
  const result = await answer(f, c);
  const before = JSON.stringify(f.service.catalog.get('document', d.id));
  for (const reason of ['wrong_source', 'outdated', 'no_answer', 'irrelevant_answer', 'other'])
    await f.exec(
      'feedback.create',
      { turn: result.turn.id, rating: -1, reason, detail: 'Review requested' },
      f.user,
    );
  assert.equal(JSON.stringify(f.service.catalog.get('document', d.id)), before);
  const quality = await f.exec<{ feedback: { sources: Source[]; settings: string }[] }>(
    'quality.list',
  );
  assert.equal(quality.feedback.length, 5);
  assert.equal(quality.feedback[0]?.sources[0]?.version, d.activeVersion);
  assert.ok(quality.feedback[0]?.settings);
  await f.exec('quality.save', {
    question: 'What is E-42?',
    scope: {},
    documents: [d.id],
    facts: ['12 Nm'],
    refuse: false,
  });
  await f.exec('quality.save', {
    question: 'E-NO-SUCH-777',
    documents: [],
    facts: [],
    refuse: true,
  });
  const job = await f.exec<Job>('quality.run');
  const completed = await wait(f.service, job.id);
  assert.equal(completed.result.total, 2);
  const checks = (
    await f.exec<{
      items: {
        sourceRetrieval: boolean;
        answerFacts: boolean;
        citationsValid: boolean;
        refusalCorrect: boolean;
        milliseconds: number;
      }[];
    }>('quality.results', { job: job.id })
  ).items;
  assert.equal(checks.length, 2);
  assert.ok(
    checks.every(
      (c) =>
        c.sourceRetrieval &&
        c.answerFacts &&
        c.citationsValid &&
        c.refusalCorrect &&
        c.milliseconds >= 0,
    ),
  );
});
void test('local backup and folder schedules execute through the same authorized service', async (t) => {
  const f = await fixture(t);
  const s = f.service.catalog.settings();
  await f.exec('settings.save', {
    revision: s.revision,
    settings: { backupIntervalHours: 1, nextBackup: 0 },
  });
  for (let i = 0; i < 100 && !(await f.exec<unknown[]>('backup.list')).length; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal((await f.exec<unknown[]>('backup.list')).length, 1);
  const { mkdirSync } = await import('node:fs');
  const directory = join(f.path, 'scheduled-folder');
  mkdirSync(directory);
  writeFileSync(join(directory, 'scheduled.txt'), 'E-66 maintenance procedure');
  const sync = await f.exec<{ id: string; nextRun: number }>('sync.save', {
    path: directory,
    collection: f.collection.id,
    policy: 'keep',
    intervalMinutes: 1,
  });
  sync.nextRun = 0;
  f.service.catalog.put('sync', sync);
  for (let i = 0; i < 100 && !f.service.catalog.list('document').length; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.service.catalog.list('document').length, 1);
});
void test('history/log/temp retention protects unfinished conversations and disk errors remain controlled', async (t) => {
  const f = await fixture(t);
  await upload(f);
  const c = await f.exec<Conversation>('conversations.create', {}, f.user);
  const completed = await answer(f, c);
  const old = f.service.catalog.get<Conversation>('conversation', c.id)!;
  old.updated = Date.now() - 400 * 86400_000;
  f.service.catalog.put('conversation', old);
  const job = f.service.catalog.get<Job>('job', completed.job.id)!;
  job.updated = Date.now() - 100 * 86400_000;
  f.service.catalog.put('job', job);
  const s = f.service.catalog.settings();
  await f.exec('settings.save', { revision: s.revision, settings: { pauseQueue: true } });
  let pending = await f.exec<Conversation>('conversations.create', {}, f.user);
  const active = await f.exec<{ job: Job }>(
    'answers.create',
    { conversation: pending.id, revision: pending.revision, question: 'E-42' },
    f.user,
  );
  pending = f.service.catalog.get<Conversation>('conversation', pending.id)!;
  pending.updated = Date.now() - 400 * 86400_000;
  f.service.catalog.put('conversation', pending);
  f.service.catalog.db
    .prepare('INSERT INTO logs(created,code,diagnostic) VALUES (?,?,?)')
    .run(Date.now() - 100 * 86400_000, 'TEST', 'test-id');
  await f.exec('cleanup');
  assert.equal(f.service.catalog.get('conversation', c.id), undefined);
  assert.ok(f.service.catalog.get('conversation', pending.id));
  assert.ok(f.service.catalog.get('job', active.job.id));
  assert.equal(f.service.catalog.db.prepare('SELECT count(*) AS n FROM logs').get()?.n, 0);
  const newer = f.service.catalog.settings();
  await f.exec('settings.save', { revision: newer.revision, settings: { minFreeBytes: 1e12 } });
  await assert.rejects(
    f.exec(
      'answers.create',
      { conversation: pending.id, revision: pending.revision, question: 'E-42' },
      f.user,
    ),
    (e: unknown) => e instanceof Error && 'code' in e && e.code === 'DISK_FULL',
  );
  assert.ok((await f.exec<{ items: unknown[] }>('documents.list', {}, f.user)).items.length);
});
void test('bulk rights validation is atomic and exclusion/archive preserve original access', async (t) => {
  const f = await fixture(t),
    first = await upload(f);
  const secret = await f.exec<Collection>('collections.save', { name: 'Secret', grants: [] });
  const second = await upload(f, 'E-77 confidential instructions', {
    collection: secret.id,
    name: 'secret.md',
  });
  await assert.rejects(
    f.exec(
      'documents.bulk',
      {
        ids: [first.id, second.id],
        revisions: { [first.id]: first.revision, [second.id]: second.revision },
        operation: 'archive',
      },
      f.editor,
    ),
    /доступ/iu,
  );
  assert.equal(f.service.catalog.get<DocumentRecord>('document', first.id)?.state, 'published');
  await f.exec(
    'documents.bulk',
    { ids: [first.id], revisions: { [first.id]: first.revision }, operation: 'exclude' },
    f.editor,
  );
  assert.deepEqual(await f.exec('search', { question: 'E-42' }, f.user), []);
  assert.ok(f.service.original(f.user, first.id, first.activeVersion).length);
  await f.exec('documents.delete', { id: second.id, revision: second.revision });
  assert.equal(f.service.catalog.get('document', second.id), undefined);
  assert.equal(
    f.service.catalog.db.prepare('SELECT count(*) AS n FROM chunks WHERE document=?').get(second.id)
      ?.n,
    0,
  );
});
void test('ACL revocation also guards information inherited from selected conversation history', async (t) => {
  const f = await fixture(t),
    a = await upload(f);
  const other = await f.exec<Collection>('collections.save', {
    name: 'Other',
    grants: [{ subject: f.user.id, access: 'read' }],
  });
  const b = await upload(f, 'E-55 adjustment procedure', {
    collection: other.id,
    name: 'other.md',
  });
  const c = await f.exec<Conversation>('conversations.create', {}, f.user);
  const first = await answer(f, c);
  const second = await answer(f, first.conversation, 'What is E-55?', {
    scope: { collection: other.id },
  });
  assert.equal(second.turn.sources[0]?.document, b.id);
  assert.ok(second.turn.accessSources?.some((s) => s.document === a.id));
  await f.exec('collections.save', {
    id: f.collection.id,
    revision: f.collection.revision,
    name: f.collection.name,
    grants: [],
  });
  assert.throws(() => f.service.jobFor(f.user, second.job.id), /отозван/iu);
  const history = await f.exec<{ turns: (Turn & { redacted?: boolean })[] }>(
    'conversations.read',
    { id: c.id },
    f.user,
  );
  assert.ok(history.turns.every((t) => t.redacted));
});
void test('schema incompatibility is checked read-only before changing an existing database', async (t) => {
  const f = await fixture(t);
  const { mkdirSync, readFileSync } = await import('node:fs');
  const { DatabaseSync } = await import('node:sqlite');
  const directory = join(f.path, 'unsupported');
  mkdirSync(directory);
  const path = join(directory, 'catalog.sqlite');
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE alien(value TEXT); INSERT INTO alien VALUES ('keep'); PRAGMA user_version=9;",
  );
  db.close();
  const before = readFileSync(path);
  assert.throws(() => new Catalog(directory), /схем/iu);
  assert.ok(before.equals(readFileSync(path)));
});
void test('local CLI recovers a blocked administrator account through the running server', async (t) => {
  const f = await fixture(t);
  const key = 'local-recovery-secret';
  writeFileSync(join(f.path, 'recovery.key'), key, { mode: 0o600 });
  const user = f.service.catalog.get<User>('user', f.user.id)!;
  await f.exec('users.update', { id: user.id, revision: user.revision, blocked: true });
  const server = createHttpServer(f.service, { recoveryKey: key });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { spawn } = await import('node:child_process');
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/interfaces/cli/main.ts', 'recover-admin', 'operator'],
      {
        env: { ...process.env, RAG_DATA_DIR: f.path, RAG_URL: 'http://127.0.0.1:' + address.port },
        stdio: ['pipe', 'ignore', 'pipe'],
      },
    );
    child.stdin.end('recovered-safe-password\n');
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
  assert.equal(code, 0);
  const recovered = await f.service.auth.login('operator', 'recovered-safe-password', 'local');
  assert.equal(recovered.user.role, 'admin');
  assert.equal(recovered.user.blocked, false);
});

void test('only the published active version is searched, history stays readable and reindex preserves selection', async (t) => {
  const f = await fixture(t);
  let d = await upload(f);
  const old = d.activeVersion;
  d = await upload(f, 'E-42 torque is 18 Nm', { document: d.id, revision: d.revision });
  const hits = await f.exec<Source[]>('search', { question: 'E-42' }, f.user);
  assert.ok(hits.length > 0);
  assert.ok(hits.every((s) => s.version === d.activeVersion));
  const previous = await f.exec<{ version: Version }>(
    'documents.read',
    { id: d.id, version: old },
    f.user,
  );
  assert.equal(previous.version.id, old);
  assert.ok(previous.version.pages[0]?.text.includes('12'));
  const job = await f.exec<Job>('documents.publish', {
    id: d.id,
    revision: d.revision,
    version: old,
    acknowledge: true,
    activate: false,
  });
  await wait(f.service, job.id);
  assert.equal(
    f.service.catalog.get<DocumentRecord>('document', d.id)?.activeVersion,
    d.activeVersion,
  );
});
void test('exact identifier boundaries prevent a prefix match for a different code', async (t) => {
  const f = await fixture(t);
  await upload(f, 'E-420 procedure');
  assert.deepEqual(await f.exec('search', { question: 'E-42' }, f.user), []);
  assert.equal((await f.exec<Source[]>('search', { question: 'E-420' }, f.user)).length, 1);
});

void test('a backup from another schema is rejected without changing current data', async (t) => {
  const f = await fixture(t);
  const d = await upload(f);
  const snapshot = await f.exec<{ id: string }>('backup.create');
  const { DatabaseSync } = await import('node:sqlite');
  const { fileHash } = await import('../src/infrastructure/files/file-hash.js');
  const path = join(f.service.catalog.settings().backupDir, snapshot.id);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA application_id=123;');
  db.close();
  writeFileSync(path + '.sha256', await fileHash(path));
  await assert.rejects(f.exec('backup.restore', { id: snapshot.id }), /несовместим/iu);
  assert.equal(
    f.service.catalog.get<DocumentRecord>('document', d.id)?.activeVersion,
    d.activeVersion,
  );
  assert.equal(f.service.catalog.list<Version>('version').length, 1);
});

void test('omitted scope inherits the selected branch and explicit empty scope selects all accessible bases', async (t) => {
  const f = await fixture(t);
  const firstDocument = await upload(f);
  const other = await f.exec<Collection>('collections.save', {
    name: 'Other',
    grants: [{ subject: f.user.id, access: 'read' }],
  });
  const secondDocument = await upload(f, 'E-42 torque is 18 Nm', { collection: other.id });
  const c = await f.exec<Conversation>('conversations.create', {}, f.user);
  const first = await answer(f, c, 'What is E-42?', { scope: { collection: f.collection.id } });
  const inherited = await answer(f, first.conversation, 'E-42 follow-up', { scope: undefined });
  assert.equal(inherited.turn.scope.collection, f.collection.id);
  assert.deepEqual(
    inherited.turn.sources.map((source) => source.document),
    [firstDocument.id],
  );
  const all = await answer(f, inherited.conversation, 'Compare E-42', { scope: {} });
  assert.equal(all.turn.scope.collection, undefined);
  assert.deepEqual(
    new Set(all.turn.sources.map((source) => source.document)),
    new Set([firstDocument.id, secondDocument.id]),
  );
});
