import { encodeVector } from '../src/infrastructure/indexing/vector-codec.js';
/** Isolated SQLite/API benchmark. Inference is excluded deliberately; no test data enters the installation. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Application } from '../src/application/application.js';
import type { ModelRuntime } from '../src/application/ports/model-runtime.js';
import { defaults } from '../src/config/default-settings.js';
import type {
  Collection,
  Conversation,
  DocumentRecord,
  Job,
  Principal,
  Turn,
  Version,
} from '../src/contracts/public.js';
import { Catalog } from '../src/infrastructure/database/catalog.js';
const directory = mkdtempSync(join(tmpdir(), 'rag-benchmark-'));
const dimensions = 128,
  chunks = Number(process.env.BENCH_CHUNKS ?? 3000),
  jobCount = 3000,
  conversations = 120;
const vector = Array.from({ length: dimensions }, () => 1 / Math.sqrt(dimensions));
const models: ModelRuntime = {
  signature: async () => 'benchmark',
  query: async () => vector,
  index: async () => [],
  generate: async () => ({ answer: '', insufficient: true }),
  health: async () => ({
    embedding: true,
    generation: true,
    indexSignature: 'benchmark',
    models: ['benchmark'],
  }),
  close: async () => {},
};
const catalog = new Catalog(directory);
const service = new Application(catalog, models, defaults(directory, 'benchmark', 'Sources only'));
const metrics: Record<string, unknown> = {
  node: process.version,
  created: new Date().toISOString(),
  dataset: { chunks, dimensions, jobs: jobCount, conversations, turns: conversations * 12 },
  inference: 'excluded',
  milliseconds: {},
};
const timings = metrics.milliseconds as Record<string, unknown>;
async function measure(name: string, work: () => unknown, samples = 4) {
  const values: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    await work();
    values.push(performance.now() - start);
  }
  const ordered = [...values].sort((a, b) => a - b);
  timings[name] = {
    median: ordered[Math.floor(ordered.length / 2)],
    max: ordered.at(-1),
    samples: values,
  };
}
try {
  await service.execute('setup.create', { login: 'bench-admin', password: 'benchmark-password' });
  const admin = catalog.list<Principal>('user')[0]!;
  const reader = (await service.execute(
    'users.create',
    { login: 'bench-reader', password: 'benchmark-password', role: 'user' },
    admin,
  )) as Principal;
  const collection = (await service.execute(
    'collections.save',
    { name: 'Benchmark', grants: [{ subject: reader.id, access: 'read' }] },
    admin,
  )) as Collection;
  catalog.transaction(() => {
    for (let doc = 0; doc < 60; doc++) {
      const id = 'd-' + doc,
        version = 'v-' + doc;
      catalog.put<DocumentRecord>('document', {
        id,
        name: 'Document ' + doc,
        collection: collection.id,
        conversation: '',
        owner: admin.id,
        revision: 1,
        activeVersion: version,
        state: 'published',
      });
      catalog.put<Version>('version', {
        id: version,
        document: id,
        name: 'document.txt',
        hash: 'benchmark',
        created: doc + 1,
        pages: Array.from({ length: 12 }, (_, page) => ({
          number: page + 1,
          text: 'Extracted document text. '.repeat(120),
          method: 'text',
          warnings: [],
          sections: [{ title: 'Section', text: 'Extracted document text. '.repeat(120) }],
        })),
        state: 'ready',
        acknowledged: true,
        signature: 'benchmark',
      });
    }
    const add = catalog.db.prepare('INSERT INTO chunks VALUES (?,?,?,?,?,?,?)'),
      fts = catalog.db.prepare('INSERT INTO fulltext(id,body) VALUES (?,?)');
    for (let i = 0; i < chunks; i++) {
      const d = i % 60,
        id = 'chunk-' + i,
        body =
          'Инструкция по проверке процедуры. Procedure reference E-' + String(i).padStart(4, '0');
      add.run(id, 'd-' + d, 'v-' + d, 1, 'Section', body, encodeVector(vector));
      fts.run(id, body);
    }
    for (let i = 0; i < jobCount; i++)
      catalog.put<Job>('job', {
        id: 'job-' + i,
        owner: admin.id,
        kind: 'document',
        status: i < 4 ? 'queued' : 'complete',
        created: 1000 + i,
        updated: 2000 + i,
        payload: { document: 'd-' + (i % 60) },
        result: {},
        error: '',
        diagnostic: '',
        settings: '{}',
      });
    for (let i = 0; i < conversations; i++) {
      catalog.put<Conversation>('conversation', {
        id: 'c-' + i,
        owner: reader.id,
        title: 'Conversation ' + i,
        draft: '',
        selected: '',
        revision: 1,
        updated: i,
      });
      for (let n = 0; n < 12; n++)
        catalog.put<Turn>('turn', {
          id: 't-' + i + '-' + n,
          conversation: 'c-' + i,
          parent: '',
          replaces: '',
          question: i === 0 ? 'needle' : 'Ordinary question',
          answer: 'Stored answer',
          sources: [],
          status: 'complete',
          job: '',
          created: n,
          scope: {},
        });
    }
  });
  const question = 'Инструкция по проверке процедуры';
  await measure(
    'searchUncached',
    async () => {
      catalog.db.exec('DELETE FROM cache');
      const hits = await service.searchSources(reader, question, { collection: collection.id });
      if (!hits.length) throw new Error('Empty benchmark retrieval');
    },
    3,
  );
  await measure(
    'searchCached',
    () => service.searchSources(reader, question, { collection: collection.id }),
    6,
  );
  await measure('operations', () => service.execute('operations', {}, admin));
  await measure('readiness', () => service.readiness(), 8);
  await measure(
    'conversationSearch',
    () => service.execute('conversations.list', { query: 'needle' }, reader),
    3,
  );
  await measure('documentsList', () => service.execute('documents.list', {}, reader));
  metrics.memory = process.memoryUsage();
  const output = resolve(process.argv[2] ?? '.cache/benchmark.json');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(metrics, null, 2) + '\n');
  console.log(JSON.stringify(metrics, null, 2));
} finally {
  await service.close();
  rmSync(directory, { recursive: true, force: true });
}
