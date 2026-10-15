import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
  ListPage,
  SourceDetails,
  Turn,
  User,
  Version,
  Operations,
} from '../src/contracts/public.js';
import { terminal } from '../src/contracts/public.js';
import { Catalog } from '../src/infrastructure/database/catalog.js';
import { decodeVector, dot, encodeVector } from '../src/infrastructure/indexing/vector-codec.js';
import { VectorCache } from '../src/infrastructure/indexing/vector-cache.js';
class Models implements ModelRuntime {
  queries = 0;
  generate: ModelRuntime['generate'] = async (
    _question,
    sources,
    _history,
    _settings,
    _signal,
    onToken,
  ) => {
    const answer = sources[0]!.text + ' [1]';
    onToken(answer);
    return { answer, insufficient: false };
  };
  async query() {
    this.queries++;
    return [0, 1, 0];
  }
  async signature() {
    return 'perf-v1';
  }
  async index() {
    return [];
  }
  async health() {
    return { embedding: true, generation: true, indexSignature: 'perf-v1', models: ['perf'] };
  }
  async close() {}
}
async function fixture(t: test.TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'rag-performance-')),
    models = new Models(),
    app = new Application(new Catalog(path), models, defaults(path, 'perf', 'Sources only'));
  t.after(async () => {
    await app.close();
    rmSync(path, { recursive: true, force: true });
  });
  await app.execute('setup.create', { login: 'admin', password: 'performance-admin-password' });
  const admin = app.auth.current(app.catalog.list<User>('user')[0]!.id),
    user = (await app.execute(
      'users.create',
      { login: 'reader', password: 'performance-reader-password' },
      admin,
    )) as User,
    collection = (await app.execute(
      'collections.save',
      { name: 'Allowed', grants: [{ subject: user.id, access: 'read' }] },
      admin,
    )) as Collection;
  return { app, models, admin, user: app.auth.current(user.id), collection };
}
function document(
  app: Application,
  id: string,
  collection: string,
  owner: string,
  text = 'E-42 requires 12 Nm.',
) {
  const version: Version = {
      id: 'v-' + id,
      document: id,
      name: id + '.txt',
      hash: '0'.repeat(64),
      created: Date.now(),
      pages: [
        { number: 1, text, method: 'text', warnings: [], sections: [{ title: 'Procedure', text }] },
        {
          number: 2,
          text: 'PRIVATE OTHER PAGE',
          method: 'text',
          warnings: [],
          sections: [{ title: 'Other', text: 'PRIVATE OTHER PAGE' }],
        },
      ],
      state: 'ready',
      acknowledged: true,
      signature: 'perf-v1',
    },
    doc: DocumentRecord = {
      id,
      name: id + '.txt',
      collection,
      conversation: '',
      owner,
      revision: 1,
      activeVersion: version.id,
      state: 'published',
    };
  app.catalog.put('document', doc);
  app.catalog.put('version', version);
  app.catalog
    .prepare('INSERT INTO chunks VALUES (?,?,?,?,?,?,?)')
    .run('c-' + id, id, version.id, 1, 'Procedure', text, encodeVector([1, 0, 0]));
  app.catalog.prepare('INSERT INTO fulltext VALUES (?,?,?)').run('c-' + id, text, id);
  return doc;
}
async function wait(app: Application, id: string) {
  for (let at = 0; at < 200; at++) {
    const job = app.catalog.get<Job>('job', id)!;
    if (terminal.has(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Job did not settle');
}
void test('binary vectors are normalized, validated and cached under a hard memory limit', () => {
  const encoded = encodeVector([3, 4, 0]);
  assert.equal(encoded.byteLength, 12);
  const decoded = decodeVector(encoded);
  assert.ok(Math.abs(dot(decoded, decoded) - 1) < 1e-6);
  assert.throws(() => encodeVector([0, 0]));
  assert.throws(() => encodeVector([Number.NaN, 1]));
  assert.throws(() => decodeVector(new Uint8Array(3)));
  const cache = new VectorCache(24);
  cache.get('one', encoded);
  cache.get('two', encoded);
  cache.get('three', encoded);
  assert.equal(cache.stats.entries, 2);
  assert.equal(cache.stats.bytes, 24);
  cache.clear();
  assert.equal(cache.stats.bytes, 0);
});
void test('lexical ranking filters forbidden documents before limiting and cached search performs no vector scan', async (t) => {
  const f = await fixture(t),
    forbidden = (await f.app.execute(
      'collections.save',
      { name: 'Forbidden', grants: [] },
      f.admin,
    )) as Collection;
  f.app.catalog.transaction(() => {
    for (let at = 0; at < 300; at++) document(f.app, 'a-forbidden-' + at, forbidden.id, f.admin.id);
    document(f.app, 'z-permitted', f.collection.id, f.admin.id);
  });
  const first = await f.app.searchSources(f.user, 'E-42', {});
  assert.equal(first.length, 1);
  assert.equal(first[0]!.document, 'z-permitted');
  assert.equal(f.models.queries, 1);
  const original = f.app.catalog.db.prepare.bind(f.app.catalog.db);
  t.mock.method(f.app.catalog.db, 'prepare', (sql: string) => {
    assert.ok(!sql.includes('c.vector'), 'cache hit must not prepare a vector scan');
    return original(sql);
  });
  assert.deepEqual(await f.app.searchSources(f.user, 'E-42', {}), first);
  assert.equal(f.models.queries, 1);
  const source = (await f.app.execute(
    'sources.read',
    { chunk: first[0]!.chunk },
    f.user,
  )) as SourceDetails;
  assert.equal(source.page.number, 1);
  assert.equal(source.source.text, 'E-42 requires 12 Nm.');
  assert.ok(!JSON.stringify(source).includes('PRIVATE OTHER PAGE'));
  await f.app.execute(
    'collections.save',
    { id: f.collection.id, revision: f.collection.revision, name: f.collection.name, grants: [] },
    f.admin,
  );
  assert.deepEqual(await f.app.searchSources(f.user, 'E-42', {}), []);
  await assert.rejects(
    f.app.execute('sources.read', { chunk: first[0]!.chunk }, f.user),
    /доступ/iu,
  );
});
void test('SQL pagination counts only accessible documents and queue metrics count beyond one page', async (t) => {
  const f = await fixture(t);
  f.app.catalog.transaction(() => {
    for (let at = 0; at < 63; at++)
      document(f.app, 'doc-' + String(at).padStart(3, '0'), f.collection.id, f.admin.id);
    for (let at = 0; at < 250; at++)
      f.app.catalog.put('job', {
        id: 'queued-' + at,
        kind: 'document',
        owner: f.admin.id,
        status: 'queued',
        created: Date.now() - 60000,
        updated: Date.now(),
        payload: {},
        result: {},
        error: '',
        diagnostic: '',
        settings: '{}',
      } satisfies Job);
  });
  const page = (await f.app.execute(
    'documents.list',
    { page: 3, pageSize: 25 },
    f.user,
  )) as ListPage<DocumentRecord>;
  assert.equal(page.total, 63);
  assert.equal(page.items.length, 13);
  assert.equal(page.items[0]!.id, 'doc-050');
  await assert.rejects(f.app.execute('documents.list', { pageSize: 1000 }, f.user), /страниц/iu);
  const metrics = (await f.app.execute('operations', {}, f.admin)) as Operations;
  assert.equal(metrics.queue.length, 250);
  assert.equal(metrics.queue.lanes[0]!.length, 250);
  assert.ok(metrics.queue.oldestAgeMs >= 60000);
  assert.equal(metrics.counts.documents, 63);
});
void test('stream persistence coalesces token writes and cancellation retains the latest partial answer', async (t) => {
  const f = await fixture(t);
  document(f.app, 'streaming', f.collection.id, f.admin.id);
  let writes = 0;
  const original = f.app.catalog.put.bind(f.app.catalog);
  t.mock.method(f.app.catalog, 'put', ((kind: string, value: { id: string }) => {
    if (kind === 'turn' && (value as Turn).answer) writes++;
    return original(kind, value);
  }) as typeof original);
  f.models.generate = async (_q, _s, _h, _settings, _signal, onToken) => {
    for (let at = 0; at < 1000; at++) onToken('word ');
    return { answer: 'word '.repeat(1000) + ' [1]', insufficient: false };
  };
  const c = (await f.app.execute('conversations.create', {}, f.user)) as Conversation,
    answer = (await f.app.execute(
      'answers.create',
      { conversation: c.id, revision: c.revision, question: 'E-42' },
      f.user,
    )) as { job: Job; turn: Turn };
  await f.app.tick();
  assert.equal((await wait(f.app, answer.job.id)).status, 'complete');
  assert.ok(writes < 25, `1000 tokens caused ${writes} durable writes`);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.models.generate = async (_q, _s, _h, _settings, signal, onToken) => {
    onToken('first ');
    onToken('latest partial');
    started();
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
    );
    return { answer: '', insufficient: false };
  };
  const next = f.app.catalog.get<Conversation>('conversation', c.id)!,
    pending = (await f.app.execute(
      'answers.create',
      { conversation: c.id, revision: next.revision, question: 'E-42 again' },
      f.user,
    )) as { job: Job; turn: Turn };
  await f.app.tick();
  await ready;
  await f.app.execute('jobs.cancel', { id: pending.job.id }, f.user);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await wait(f.app, pending.job.id)).status, 'cancelled');
  assert.equal(f.app.catalog.get<Turn>('turn', pending.turn.id)!.answer, 'first latest partial');
});
void test('creating a user with groups and blocked state is atomic and validates all groups', async (t) => {
  const f = await fixture(t),
    group = (await f.app.execute('groups.save', { name: 'Reviewers' }, f.admin)) as { id: string };
  const user = (await f.app.execute(
    'users.create',
    {
      login: 'blocked-reviewer',
      password: 'blocked-reviewer-password',
      groups: [group.id],
      blocked: true,
      role: 'editor',
    },
    f.admin,
  )) as User;
  assert.deepEqual(user.groups, [group.id]);
  assert.equal(user.blocked, true);
  assert.ok(!('password' in user));
  const before = f.app.catalog.count('user');
  await assert.rejects(
    f.app.execute(
      'users.create',
      { login: 'invalid-user', password: 'invalid-user-password', groups: ['missing'] },
      f.admin,
    ),
    /групп/iu,
  );
  assert.equal(f.app.catalog.count('user'), before);
  await assert.rejects(
    f.app.execute('users.update', { id: user.id, revision: user.revision, login: 'bad' }, f.admin),
    /поля/iu,
  );
});
