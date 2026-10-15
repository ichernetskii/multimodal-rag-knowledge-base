import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Application } from '../src/application/application.js';
import type { ModelRuntime } from '../src/application/ports/model-runtime.js';
import { defaults } from '../src/config/default-settings.js';
import { loadRuntimeConfig, bindDeployment } from '../src/config/runtime-config.js';
import type {
  Collection,
  Conversation,
  ConversationDetails,
  DocumentRecord,
  Job,
  ListPage,
  Turn,
  TurnVariant,
  Version,
  SourceDetails,
  User,
} from '../src/contracts/public.js';
import { terminal } from '../src/contracts/public.js';
import { Catalog } from '../src/infrastructure/database/catalog.js';
import { AppError } from '../src/shared/errors.js';
import { serveApplication } from '../src/app/bootstrap.js';
import { createServer } from 'node:http';
import {
  originalBlockSize,
  storeOriginal,
  readOriginal,
  originalRange,
} from '../src/infrastructure/database/original-store.js';
import { extract } from '../src/infrastructure/extraction/extract.js';
import { createHttpServer } from '../src/interfaces/http/server.js';
import { api as cliApi, download } from '../src/interfaces/cli/api-client.js';

class Models implements ModelRuntime {
  async signature() {
    return 'refactor-v1';
  }
  async query() {
    return [1, 0, 0];
  }
  async health() {
    return { embedding: true, generation: true, indexSignature: 'refactor-v1', models: ['test'] };
  }
  async close() {}
  index: ModelRuntime['index'] = async (_name, pages) =>
    pages.flatMap((page) =>
      page.sections.map((section) => ({
        page: page.number,
        section: section.title,
        body: section.text,
        vector: [1, 0, 0],
      })),
    );
  generate: ModelRuntime['generate'] = async (_q, sources, _h, _settings, _signal, onToken) => {
    const answer = sources[0]!.text + ' [1]';
    onToken(answer);
    return { answer, insufficient: false };
  };
}
async function fixture(t: test.TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'rag-refactor-')),
    models = new Models(),
    app = new Application(new Catalog(path), models, defaults(path, 'test', 'Use sources'));
  t.after(async () => {
    await app.close();
    rmSync(path, { recursive: true, force: true });
  });
  await app.execute('setup.create', { login: 'admin', password: 'refactor-admin-password' });
  const session = await app.auth.login('admin', 'refactor-admin-password', 'test'),
    admin = app.auth.current(session.user.id),
    collection = (await app.execute(
      'collections.save',
      { name: 'Документы', grants: [] },
      admin,
    )) as Collection;
  return { app, models, path, admin, session, collection };
}
async function settle(app: Application, id: string) {
  for (let index = 0; index < 200; index++) {
    const job = app.catalog.get<Job>('job', id);
    if (!job || terminal.has(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Job timeout');
}
async function upload(f: Awaited<ReturnType<typeof fixture>>, name = 'Инструкция.txt') {
  const result = (await f.app.execute(
    'documents.upload',
    {
      name,
      collection: f.collection.id,
      base64: Buffer.from('E-42: tighten bolt to 12 Nm.').toString('base64'),
    },
    f.admin,
  )) as { document: DocumentRecord; version: Version; job: Job };
  await f.app.tick();
  assert.equal((await settle(f.app, result.job.id))?.status, 'complete');
  return {
    ...result,
    document: f.app.catalog.get<DocumentRecord>('document', result.document.id)!,
  };
}
void test('prototype names cannot be dispatched as API actions or saved as settings', async (t) => {
  const f = await fixture(t);
  for (const action of ['constructor', '__proto__', 'toString'])
    await assert.rejects(
      f.app.execute(action, {}, f.admin),
      (error: unknown) => error instanceof AppError && error.code === 'ACTION_NOT_FOUND',
    );
  const settings = f.app.catalog.settings();
  await assert.rejects(
    f.app.execute(
      'settings.save',
      {
        revision: settings.revision,
        settings: JSON.parse('{"__proto__":{"pauseIntake":true}}'),
      },
      f.admin,
    ),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_SETTINGS',
  );
  assert.equal(f.app.catalog.settings().revision, settings.revision);
  assert.equal(f.app.catalog.settings().pauseIntake, false);
});
void test('quality reports do not publish private attachment text to another administrator', async (t) => {
  const f = await fixture(t),
    c = (await f.app.execute('conversations.create', {}, f.admin)) as Conversation,
    uploaded = (await f.app.execute(
      'documents.upload',
      {
        conversation: c.id,
        name: 'private.txt',
        base64: Buffer.from('Private attachment fact: 73921.').toString('base64'),
      },
      f.admin,
    )) as { document: DocumentRecord; job: Job };
  await f.app.tick();
  await settle(f.app, uploaded.job.id);
  await assert.rejects(
    f.app.execute(
      'quality.save',
      {
        question: 'Private attachment fact?',
        documents: [uploaded.document.id],
        facts: ['73921'],
      },
      f.admin,
    ),
    (error: unknown) => error instanceof AppError && error.code === 'QUALITY_SCOPE',
  );
  const current = f.app.catalog.get<Conversation>('conversation', c.id)!,
    answer = (await f.app.execute(
      'answers.create',
      {
        conversation: c.id,
        revision: current.revision,
        question: 'Private question 73921',
        scope: { conversation: c.id },
      },
      f.admin,
    )) as { turn: Turn; job: Job };
  await f.app.tick();
  assert.equal((await settle(f.app, answer.job.id))?.status, 'complete');
  await f.app.execute(
    'feedback.create',
    { turn: answer.turn.id, rating: -1, reason: 'wrong_source', detail: '' },
    f.admin,
  );
  const other = (await f.app.execute(
    'users.create',
    { login: 'other-admin', password: 'other-admin-password', role: 'admin' },
    f.admin,
  )) as User;
  const report = (await f.app.execute('quality.list', {}, other)) as {
    feedback: { question: string; answer: string; sources: unknown[] }[];
  };
  assert.equal(report.feedback.length, 1);
  assert.ok(!report.feedback[0]!.question.includes('73921'));
  assert.ok(!report.feedback[0]!.answer.includes('73921'));
  assert.deepEqual(report.feedback[0]!.sources, []);
  const own = (await f.app.execute('quality.list', {}, f.admin)) as typeof report;
  assert.match(own.feedback[0]!.answer, /73921/u);
});
void test('Unicode list search handles uppercase Russian names and questions', async (t) => {
  const f = await fixture(t),
    doc = await upload(f);
  const docs = (await f.app.execute(
    'documents.list',
    { query: 'ИНСТРУКЦИЯ' },
    f.admin,
  )) as ListPage<DocumentRecord>;
  assert.deepEqual(
    docs.items.map((item) => item.id),
    [doc.document.id],
  );
  const c = (await f.app.execute(
    'conversations.create',
    { title: 'Проверка РЕЗЕРВНОЙ копии' },
    f.admin,
  )) as Conversation;
  const conversations = (await f.app.execute(
    'conversations.list',
    { query: 'резервной' },
    f.admin,
  )) as ListPage<Conversation>;
  assert.equal(conversations.items[0]?.id, c.id);
});
void test('long conversations page the selected branch, page alternatives and export every version', async (t) => {
  const f = await fixture(t),
    c = (await f.app.execute('conversations.create', {}, f.admin)) as Conversation;
  f.app.catalog.transaction(() => {
    for (let index = 0; index < 125; index++)
      f.app.catalog.put('turn', {
        id: 'turn-' + index,
        conversation: c.id,
        parent: index ? 'turn-' + (index - 1) : '',
        replaces: '',
        question: 'Question ' + index,
        answer: 'Answer ' + index,
        sources: [],
        status: 'complete',
        job: 'missing-' + index,
        created: index,
        scope: {},
      } satisfies Turn);
    for (let index = 0; index < 25; index++)
      f.app.catalog.put('turn', {
        id: 'alternative-' + index,
        conversation: c.id,
        parent: 'turn-123',
        replaces: 'turn-124',
        question: 'Alternative ' + index,
        answer: 'Preserved result',
        sources: [],
        status: 'complete',
        job: 'missing-alt-' + index,
        created: 1000 + index,
        scope: {},
      } satisfies Turn);
    c.selected = 'turn-124';
    f.app.catalog.put('conversation', c);
  });
  const latest = (await f.app.execute(
    'conversations.read',
    { id: c.id },
    f.admin,
  )) as ConversationDetails;
  assert.equal(latest.turns.length, 40);
  assert.equal(latest.turns[0]?.id, 'turn-85');
  assert.equal(latest.variantCounts['turn-123'], 26);
  const older = (await f.app.execute(
    'conversations.read',
    { id: c.id, before: latest.history.before },
    f.admin,
  )) as ConversationDetails;
  assert.equal(older.turns.length, 40);
  assert.equal(older.turns.at(-1)?.id, 'turn-84');
  const alternatives = (await f.app.execute(
    'conversations.variants',
    { id: c.id, parent: 'turn-123', page: 2, pageSize: 10 },
    f.admin,
  )) as ListPage<TurnVariant>;
  assert.equal(alternatives.total, 26);
  assert.equal(alternatives.items.length, 10);
  const exported = f.app.exportConversation(f.admin, c.id);
  try {
    assert.equal([...exported.turns].length, 150);
  } finally {
    exported.close();
  }
  await assert.rejects(f.app.execute('conversations.export', { id: c.id }, f.admin), /Неизвестн/iu);
});
void test('deleting a conversation during buffered generation cannot resurrect its turn or job', async (t) => {
  const f = await fixture(t);
  await upload(f);
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  f.models.generate = async (_q, _s, _h, _settings, signal, onToken) => {
    onToken('first ');
    onToken('buffered secret');
    ready();
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
    );
    return { answer: '', insufficient: false };
  };
  const c = (await f.app.execute('conversations.create', {}, f.admin)) as Conversation,
    result = (await f.app.execute(
      'answers.create',
      { conversation: c.id, revision: c.revision, question: 'E-42' },
      f.admin,
    )) as { conversation: Conversation; turn: Turn; job: Job };
  await f.app.tick();
  await started;
  await f.app.execute(
    'conversations.delete',
    { id: c.id, revision: result.conversation.revision },
    f.admin,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.app.catalog.get('turn', result.turn.id), undefined);
  assert.equal(f.app.catalog.get('job', result.job.id), undefined);
  assert.equal(f.app.catalog.count('turn'), 0);
});
void test('purging a source during generation removes buffered content and derived references', async (t) => {
  const f = await fixture(t),
    doc = await upload(f);
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  f.models.generate = async (_q, _s, _h, _settings, signal, onToken) => {
    onToken('first ');
    onToken('buffered secret');
    ready();
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
    );
    return { answer: '', insufficient: false };
  };
  const c = (await f.app.execute('conversations.create', {}, f.admin)) as Conversation,
    result = (await f.app.execute(
      'answers.create',
      { conversation: c.id, revision: c.revision, question: 'E-42' },
      f.admin,
    )) as { turn: Turn; job: Job };
  await f.app.tick();
  await started;
  await f.app.execute(
    'documents.delete',
    { id: doc.document.id, revision: doc.document.revision },
    f.admin,
  );
  await settle(f.app, result.job.id);
  const turn = f.app.catalog.get<Turn>('turn', result.turn.id)!;
  assert.equal(turn.answer, 'Источник окончательно удалён.');
  assert.deepEqual(turn.sources, []);
  assert.deepEqual(turn.accessSources, []);
  assert.equal(turn.status, 'interrupted');
  assert.equal(f.app.catalog.count('version'), 0);
});
void test('HTTP range, streaming export, CLI downloads and online restore share authorization', async (t) => {
  const f = await fixture(t),
    doc = await upload(f),
    server = createHttpServer(f.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port,
    headers = { Authorization: 'Bearer ' + f.session.token };
  const range = await fetch(origin + '/api/documents/' + doc.document.id, {
    headers: { ...headers, Range: 'bytes=0-3' },
  });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'E-42');
  assert.match(range.headers.get('content-range') ?? '', /^bytes 0-3\//u);
  assert.equal(
    (
      await fetch(origin + '/api/documents/' + doc.document.id, { method: 'HEAD', headers })
    ).headers.get('content-length'),
    String(Buffer.byteLength('E-42: tighten bolt to 12 Nm.')),
  );
  assert.equal(
    (
      await fetch(origin + '/api/documents/' + doc.document.id, {
        headers: { ...headers, Range: 'bytes=100-200' },
      })
    ).status,
    416,
  );
  assert.equal((await fetch(origin + '/api/documents/' + doc.document.id)).status, 401);
  const c = (await f.app.execute(
    'conversations.create',
    { title: 'Export test' },
    f.admin,
  )) as Conversation;
  const exported = await fetch(origin + '/api/conversations/' + c.id + '/export', { headers });
  assert.deepEqual(((await exported.json()) as { turns: unknown[] }).turns, []);
  assert.match(exported.headers.get('content-disposition') ?? '', /attachment/u);
  const previousUrl = process.env.RAG_URL,
    previousToken = process.env.RAG_TOKEN;
  process.env.RAG_URL = origin;
  process.env.RAG_TOKEN = f.session.token;
  t.after(() => {
    if (previousUrl === undefined) delete process.env.RAG_URL;
    else process.env.RAG_URL = previousUrl;
    if (previousToken === undefined) delete process.env.RAG_TOKEN;
    else process.env.RAG_TOKEN = previousToken;
  });
  const output = join(f.path, 'download.txt');
  await download('/api/documents/' + doc.document.id, output);
  assert.equal(readFileSync(output, 'utf8'), 'E-42: tighten bolt to 12 Nm.');
  await assert.rejects(download('/api/documents/' + doc.document.id, output), /уже существует/iu);
  assert.ok(!readdirSync(f.path).some((name) => name.endsWith('.partial')));
  await assert.rejects(
    cliApi('settings.save', { revision: 999, settings: {} }),
    (error) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'REVISION_CONFLICT' &&
      'diagnostic' in error,
  );
  const copy = (await f.app.execute('backup.create', {}, f.admin)) as { id: string };
  const restored = await fetch(origin + '/api/actions/backup.restore', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: copy.id }),
  });
  assert.equal(restored.status, 200, await restored.clone().text());
  assert.equal(((await restored.json()) as { sessionsRevoked: boolean }).sessionsRevoked, true);
  assert.equal(
    (await fetch(origin + '/api/documents/' + doc.document.id, { headers })).status,
    401,
  );
});
void test('restored model settings rebind deployment paths and endpoints without changing semantic configuration', () => {
  const saved = loadRuntimeConfig({
      EMBEDDING_CACHE: '/old/model',
      OLLAMA_URL: 'http://old-host:11434',
      EMBEDDING_THREADS: '2',
      CHUNK_TOKENS: '128',
    }),
    current = loadRuntimeConfig({
      EMBEDDING_CACHE: '/new/model',
      OLLAMA_URL: 'http://new-host:11434',
      EMBEDDING_THREADS: '6',
    }),
    bound = bindDeployment(saved, current);
  assert.equal(bound.artifacts.directory, current.artifacts.directory);
  assert.equal(bound.ollama.url, current.ollama.url);
  assert.equal(bound.model.threads, 6);
  assert.equal(bound.app.chunking.targetTokens, 128);
  assert.deepEqual(bound.embedding, saved.embedding);
  assert.throws(
    () => loadRuntimeConfig({ OLLAMA_URL: 'https://user:pass@example.test/' }),
    /origin/iu,
  );
});
void test('extracted text limit rejects oversized input before parsing or inference', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'rag-text-limit-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const settings = { ...defaults(path, 'test', 'test'), maxTextCharacters: 1000 };
  await assert.rejects(
    extract(
      'large.txt',
      Buffer.from('x'.repeat(1001)),
      settings,
      new AbortController().signal,
      () => {},
    ),
    (error) => error instanceof Error && 'code' in error && error.code === 'EXTRACTED_TEXT_LIMIT',
  );
});

void test('original storage reads boundary-crossing ranges from at most two bounded blocks', (t) => {
  const path = mkdtempSync(join(tmpdir(), 'rag-original-blocks-')),
    catalog = new Catalog(path);
  t.after(() => {
    catalog.close();
    rmSync(path, { recursive: true, force: true });
  });
  const bytes = Buffer.alloc(originalBlockSize * 3 + 7);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  catalog.transaction(() => storeOriginal(catalog, 'version', bytes));
  assert.equal(catalog.prepare('SELECT count(*) AS n FROM original_blocks').get()?.n, 4);
  assert.deepEqual(readOriginal(catalog, 'version'), bytes);
  assert.deepEqual(
    originalRange(catalog, 'version', originalBlockSize - 3, 100),
    bytes.subarray(originalBlockSize - 3, originalBlockSize + 97),
  );
  assert.deepEqual(originalRange(catalog, 'version', bytes.length - 7, 7), bytes.subarray(-7));
  catalog.prepare('DELETE FROM originals WHERE version=?').run('version');
  assert.equal(catalog.prepare('SELECT count(*) AS n FROM original_blocks').get()?.n, 0);
});

void test('user changes, session revocation and cache epochs roll back together on a write failure', async (t) => {
  const f = await fixture(t),
    user = (await f.app.execute(
      'users.create',
      { login: 'atomic-reader', password: 'atomic-reader-password', role: 'user' },
      f.admin,
    )) as User,
    session = await f.app.auth.login('atomic-reader', 'atomic-reader-password', 'test'),
    epoch = f.app.catalog.accessEpoch();
  t.mock.method(f.app.catalog, 'invalidate', () => {
    throw new AppError('DISK_FULL', 'Disk full', 507);
  });
  await assert.rejects(
    f.app.execute('users.update', { id: user.id, revision: user.revision, blocked: true }, f.admin),
    /Disk full/u,
  );
  assert.equal(f.app.catalog.get<User>('user', user.id)?.blocked, false);
  assert.equal(f.app.catalog.accessEpoch(), epoch);
  assert.equal(f.app.auth.principal(session.token).id, user.id);
});
void test('clean production bootstrap accepts an external backup directory before setup', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'rag-bootstrap-')),
    probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const previous = {
    RAG_DATA_DIR: process.env.RAG_DATA_DIR,
    RAG_BACKUP_DIR: process.env.RAG_BACKUP_DIR,
    RAG_PORT: process.env.RAG_PORT,
    RAG_HOST: process.env.RAG_HOST,
  };
  Object.assign(process.env, {
    RAG_DATA_DIR: join(path, 'data'),
    RAG_BACKUP_DIR: join(path, 'copies'),
    RAG_PORT: String(port),
    RAG_HOST: '127.0.0.1',
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const running = await serveApplication();
  t.after(async () => {
    running.server.closeAllConnections();
    await new Promise<void>((resolve) => running.server.close(() => resolve()));
    await running.service.close();
    rmSync(path, { recursive: true, force: true });
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/actions/setup.status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 200);
  const result = (await response.json()) as {
    initialized: boolean;
    defaults: { backupDir: string };
  };
  assert.equal(result.initialized, false);
  assert.equal(result.defaults.backupDir, join(path, 'copies'));
});

void test('citations survive reindexing and remain protected until their saved conversation expires', async (t) => {
  const f = await fixture(t),
    doc = await upload(f),
    c = (await f.app.execute('conversations.create', {}, f.admin)) as Conversation,
    answer = (await f.app.execute(
      'answers.create',
      { conversation: c.id, revision: c.revision, question: 'E-42' },
      f.admin,
    )) as { job: Job };
  await f.app.tick();
  await settle(f.app, answer.job.id);
  const turn = f.app.catalog.find<Turn>('turn', 'conversation=?', [c.id])[0]!,
    source = turn.sources[0]!;
  assert.ok(source);
  f.models.index = async () => [
    { page: 1, section: 'Text', body: 'tighten bolt to 12 Nm.', vector: [1, 0, 0] },
  ];
  const renamed = (await f.app.execute(
    'documents.update',
    { id: doc.document.id, revision: doc.document.revision, name: 'Порядок работы' },
    f.admin,
  )) as DocumentRecord;
  const indexing = (await f.app.execute(
    'documents.publish',
    { id: doc.document.id, revision: renamed.revision, version: doc.version.id, acknowledge: true },
    f.admin,
  )) as Job;
  await f.app.tick();
  assert.equal((await settle(f.app, indexing.id))?.status, 'complete');
  assert.equal(
    f.app.catalog.get<DocumentRecord>('document', doc.document.id)?.name,
    'Порядок работы',
  );
  assert.equal(
    f.app.catalog.prepare('SELECT 1 FROM chunks WHERE id=?').get(source.chunk),
    undefined,
  );
  const old = (await f.app.execute(
    'sources.read',
    { chunk: source.chunk },
    f.admin,
  )) as SourceDetails;
  assert.equal(old.source.text, source.text);
  assert.equal(old.page.number, source.page);
  const copy = (await f.app.execute('backup.create', {}, f.admin)) as { id: string };
  await f.app.execute('backup.verify', { id: copy.id }, f.admin);
  f.app.catalog
    .prepare('UPDATE source_fragments SET created=? WHERE id=?')
    .run(Date.now() - 50 * 86400000, source.chunk);
  await f.app.execute('cleanup', {}, f.admin);
  assert.ok(f.app.catalog.prepare('SELECT 1 FROM source_fragments WHERE id=?').get(source.chunk));
  const current = f.app.catalog.get<Conversation>('conversation', c.id)!;
  await f.app.execute('conversations.delete', { id: c.id, revision: current.revision }, f.admin);
  await f.app.execute('cleanup', {}, f.admin);
  assert.equal(f.app.catalog.prepare('SELECT count(*) AS n FROM source_usage').get()?.n, 0);
  await assert.rejects(
    f.app.execute('sources.read', { chunk: source.chunk }, f.admin),
    /не найден/iu,
  );
});
void test('permanent document deletion removes evaluation facts that expected the deleted source', async (t) => {
  const f = await fixture(t),
    doc = await upload(f);
  await f.app.execute(
    'quality.save',
    { question: 'E-MISSING-900', documents: [doc.document.id], facts: ['12'], refuse: false },
    f.admin,
  );
  const job = (await f.app.execute('quality.run', {}, f.admin)) as Job;
  assert.equal(job.result.total, 1);
  await f.app.tick();
  assert.equal((await settle(f.app, job.id))?.status, 'complete');
  assert.equal(f.app.catalog.count('evaluation_result'), 1);
  await f.app.execute(
    'documents.delete',
    { id: doc.document.id, revision: doc.document.revision },
    f.admin,
  );
  assert.equal(f.app.catalog.count('evaluation_result'), 0);
  assert.equal(f.app.catalog.count('check'), 0);
  assert.equal(f.app.catalog.prepare('SELECT count(*) AS n FROM source_fragments').get()?.n, 0);
  assert.equal(f.app.catalog.get<Job>('job', job.id)?.status, 'interrupted');
});
