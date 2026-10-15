/** Real PDFs, selective local OCR, ONNX, Ollama streaming and isolated restore. No model doubles. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Application } from '../src/application/application.js';
import { defaults } from '../src/config/default-settings.js';
import { loadRuntimeConfig } from '../src/config/runtime-config.js';
import type {
  Collection,
  Conversation,
  DocumentRecord,
  Job,
  Principal,
  Source,
  SourceDetails,
  Turn,
  Version,
} from '../src/domain/entities.js';
import { terminal } from '../src/domain/entities.js';
import { restoreInstallation } from '../src/features/backup/backup-service.js';
import { Catalog } from '../src/infrastructure/database/catalog.js';
import { LocalModelRuntime } from '../src/infrastructure/models/local-models.js';
import { visionCommand } from '../src/infrastructure/extraction/health.js';
import { createHttpServer } from '../src/interfaces/http/server.js';
import type { Input } from '../src/shared/input.js';
const directory = mkdtempSync(join(tmpdir(), 'rag-real-product-'));
const fixtures = resolve(import.meta.dirname, '../tests/fixtures/pdf');
const config = loadRuntimeConfig();
const service = new Application(
  new Catalog(directory),
  new LocalModelRuntime(config),
  defaults(directory, config.llm.model, config.app.context.systemPrompt),
);
const server = createHttpServer(service);
const evidence: Input = {
  started: new Date().toISOString(),
  runtime: {
    node: process.version,
    generation: config.llm.model,
    ocr: visionCommand() ? 'Apple Vision' : 'Tesseract',
    embedding: config.artifacts.repository,
  },
  steps: [],
};
const steps = evidence.steps as Input[];
const step = (name: string, result: unknown) => {
  steps.push({ name, result });
  console.log(name + ': PASS');
};
async function wait(id: string) {
  for (let i = 0; i < 1200; i++) {
    const j = service.catalog.get<Job>('job', id)!;
    if (terminal.has(j.status)) {
      assert.equal(j.error, '', j.error + ' ' + j.diagnostic);
      return j;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('job timeout');
}
let token = '';
let url = '';
async function api<T>(action: string, p: Input = {}): Promise<T> {
  const response = await fetch(url + '/api/actions/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(p),
  });
  const data = (await response.json()) as T;
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}
try {
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  url = 'http://127.0.0.1:' + address.port;
  service.start();
  await api('setup.create', { login: 'admin', password: 'real-admin-password' });
  const admin = await service.auth.login('admin', 'real-admin-password', 'local');
  token = admin.token;
  const user = await api<Principal>('users.create', {
    login: 'engineer',
    password: 'real-user-password',
    role: 'user',
  });
  const collection = await api<Collection>('collections.save', {
    name: 'Knowledge base',
    grants: [{ subject: user.id, access: 'read' }],
  });
  const extractionCollection = await api<Collection>('collections.save', {
    name: 'Extraction checks',
    grants: [{ subject: user.id, access: 'read' }],
  });
  step('clean installation and users', { user: user.id });
  const docs: DocumentRecord[] = [];
  for (const name of ['text.pdf', 'scan.pdf', 'mixed.pdf', 'tables.pdf']) {
    const bytes = readFileSync(resolve(fixtures, name));
    const uploaded = await api<{ document: DocumentRecord; version: Version; job: Job }>(
      'documents.upload',
      {
        collection: name === 'text.pdf' ? collection.id : extractionCollection.id,
        name,
        base64: bytes.toString('base64'),
      },
    );
    let job = await wait(uploaded.job.id);
    const version = service.catalog.get<Version>('version', uploaded.version.id)!;
    assert.ok(version.pages.every((p) => p.text.trim()));
    if (name === 'text.pdf' || name === 'tables.pdf')
      assert.ok(version.pages.every((p) => p.method === 'text'));
    if (name === 'scan.pdf') assert.equal(version.pages[0]?.method, 'ocr');
    if (name === 'mixed.pdf') {
      assert.equal(version.pages[0]?.method, 'text');
      assert.equal(version.pages[1]?.method, 'ocr');
    }
    if (name === 'tables.pdf')
      assert.match(
        version.pages[0]!.text,
        /Part code: A-100\/B; Torque \(Nm\): 12; Error code: E-42/u,
      );
    if (version.state === 'review') {
      assert.equal(
        service.catalog.get<DocumentRecord>('document', uploaded.document.id)?.state,
        'draft',
      );
      const j = await api<Job>('documents.publish', {
        id: uploaded.document.id,
        version: version.id,
        revision: uploaded.document.revision,
        acknowledge: true,
      });
      job = await wait(j.id);
    }
    assert.equal(job.status, 'complete');
    docs.push(service.catalog.get<DocumentRecord>('document', uploaded.document.id)!);
    step('PDF ' + name, {
      pages: version.pages.map((p) => ({
        number: p.number,
        method: p.method,
        warnings: p.warnings,
      })),
      chunks: job.result.chunks,
    });
  }
  const reader = await service.auth.login('engineer', 'real-user-password', 'local');
  token = reader.token;
  const hits = await api<Source[]>('search', {
    question: 'What does E-42 mean?',
    scope: { collection: collection.id },
  });
  assert.equal(hits[0]?.document, docs[0]?.id);
  step('hybrid search', { source: hits[0]?.document });
  const conversation = await api<Conversation>('conversations.create');
  const answer = await api<{ job: Job; turn: Turn; conversation: Conversation }>('answers.create', {
    conversation: conversation.id,
    revision: conversation.revision,
    question: 'What torque must the safety bolt be tightened to for error E-42?',
    scope: { collection: collection.id },
  });
  const stream = await fetch(url + '/api/events/' + answer.job.id, {
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.equal(stream.headers.get('x-accel-buffering'), 'no');
  const read = stream.body!.getReader();
  let snapshots = 0;
  let gotGenerating = false;
  let buffer = '';
  const decoder = new TextDecoder();
  while (true) {
    const part = await read.read();
    assert.ok(!part.done);
    buffer += decoder.decode(part.value, { stream: true });
    let at: number;
    let finished = false;
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const data = /^data: (.+)$/mu.exec(event)?.[1];
      if (data && event.includes('event: snapshot')) {
        const snapshot = JSON.parse(data) as { job: Job };
        snapshots++;
        if (snapshot.job.status === 'generating') gotGenerating = true;
        if (terminal.has(snapshot.job.status)) finished = true;
      }
    }
    if (finished) break;
  }
  await read.cancel();
  const job = await wait(answer.job.id);
  const turn = service.catalog.get<Turn>('turn', answer.turn.id)!;
  assert.equal(job.status, 'complete');
  assert.match(turn.answer, /12/u);
  assert.match(turn.answer, /\[1\]/u);
  assert.ok(gotGenerating);
  step('real streamed answer', { snapshots, status: job.status, answer: turn.answer });
  const source = turn.sources[0]!;
  const original = await fetch(
    url + `/api/documents/${source.document}?version=${source.version}`,
    { headers: { Authorization: 'Bearer ' + token } },
  );
  assert.equal(original.status, 200);
  assert.equal(original.headers.get('content-type'), 'application/pdf');
  assert.ok(
    Buffer.from(await original.arrayBuffer()).equals(readFileSync(resolve(fixtures, 'text.pdf'))),
  );
  assert.equal(source.page, 1);
  step('source open and original', {
    page: source.page,
    section: source.section,
    version: source.version,
  });
  token = admin.token;
  const beforeReindex = await api<SourceDetails>('sources.read', { chunk: source.chunk });
  const reindexed = await api<Job>('documents.publish', {
    id: docs[0]!.id,
    revision: docs[0]!.revision,
    version: source.version,
    acknowledge: true,
    activate: true,
  });
  assert.equal((await wait(reindexed.id)).status, 'complete');
  const savedSource = await api<SourceDetails>('sources.read', { chunk: source.chunk });
  assert.equal(savedSource.source.text, beforeReindex.source.text);
  assert.equal(savedSource.version.id, source.version);
  const range = await fetch(url + `/api/documents/${source.document}?version=${source.version}`, {
    headers: { Authorization: 'Bearer ' + token, Range: 'bytes=0-63' },
  });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 64);
  step('saved citation survives reindex and original supports bounded ranges', {
    chunk: source.chunk,
    version: savedSource.version.id,
    rangeStatus: range.status,
  });
  const current = service.catalog.get<DocumentRecord>('document', docs[0]!.id)!;
  const update = await api<{ document: DocumentRecord; job: Job }>('documents.upload', {
    document: current.id,
    revision: current.revision,
    collection: collection.id,
    name: 'updated.md',
    base64: Buffer.from(
      '# ACME AX-100 R2\nError E-42: tighten the safety bolt to 18 Nm. Isolate electrical power first.',
    ).toString('base64'),
  });
  await wait(update.job.id);
  token = reader.token;
  const c = service.catalog.get<Conversation>('conversation', conversation.id)!;
  const next = await api<{ job: Job; turn: Turn }>('answers.create', {
    conversation: c.id,
    revision: c.revision,
    question:
      'What torque must the safety bolt be tightened to for E-42 according to the current manual?',
    scope: { collection: collection.id },
  });
  await wait(next.job.id);
  const changed = service.catalog.get<Turn>('turn', next.turn.id)!;
  assert.match(changed.answer, /18/u);
  assert.ok(
    changed.sources.every(
      (s) =>
        s.version === service.catalog.get<DocumentRecord>('document', current.id)?.activeVersion,
    ),
  );
  step('document update and cache invalidation', { answer: changed.answer });
  const branch = service.catalog.get<Conversation>('conversation', conversation.id)!;
  const comparison = await api<{ job: Job; turn: Turn }>('answers.create', {
    conversation: branch.id,
    revision: branch.revision,
    question:
      'Compare all available current documents for the E-42 safety bolt. Some say 12 Nm and another says 18 Nm. Identify the conflict and cite the documents.',
    scope: {},
  });
  await wait(comparison.job.id);
  const conflict = service.catalog.get<Turn>('turn', comparison.turn.id)!;
  assert.equal(conflict.status, 'complete');
  assert.match(conflict.answer, /12/u);
  assert.match(conflict.answer, /18/u);
  const conflictCitations = [...conflict.answer.matchAll(/\[(\d+)\]/gu)].map((match) =>
    Number(match[1]),
  );
  assert.ok(
    new Set(conflictCitations).size >= 2,
    'Conflict must cite at least two distinct sources',
  );
  assert.ok(
    conflictCitations.every((id) => conflict.sources.some((source) => source.id === id)),
    'Every citation must resolve to a retrieved source',
  );
  assert.match(conflict.answer, /conflict|contradict|differ/iu);
  step('contradictory current documents are explicit', {
    answer: conflict.answer,
    versions: conflict.sources.map((s) => s.version),
  });
  token = admin.token;
  await api('quality.save', {
    question: 'What torque for the E-42 safety bolt?',
    scope: { collection: collection.id },
    documents: [current.id],
    facts: ['18'],
    refuse: false,
  });
  await api('quality.save', {
    question: 'Explain E-UNKNOWN-999',
    documents: [],
    facts: [],
    refuse: true,
  });
  const evaluation = await api<Job>('quality.run');
  const evaluated = await wait(evaluation.id);
  const results = (
    await api<{
      items: {
        sourceRetrieval: boolean;
        answerFacts: boolean;
        citationsValid: boolean;
        refusalCorrect: boolean;
      }[];
    }>('quality.results', { job: evaluation.id })
  ).items;
  assert.ok(
    results.every(
      (r) => r.sourceRetrieval && r.answerFacts && r.citationsValid && r.refusalCorrect,
    ),
  );
  step('quality checks', evaluated.result);
  await api('collections.save', {
    id: collection.id,
    revision: collection.revision,
    name: collection.name,
    grants: [],
  });
  await api('collections.save', {
    id: extractionCollection.id,
    revision: extractionCollection.revision,
    name: extractionCollection.name,
    grants: [],
  });
  token = reader.token;
  assert.deepEqual(await api('search', { question: 'E-42' }), []);
  const denied = await fetch(url + '/api/events/' + next.job.id, {
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.equal(denied.status, 403);
  step('rights change denies cached answers and SSE', { status: denied.status });
  token = admin.token;
  const backup = await api<{ id: string }>('backup.create');
  await api('backup.verify', { id: backup.id });
  const restoredDir = join(directory, 'restored');
  const restored = await restoreInstallation(
    join(service.catalog.settings().backupDir, backup.id),
    restoredDir,
  );
  const catalog = new Catalog(restoredDir);
  const restoredService = new Application(
    catalog,
    new LocalModelRuntime(config),
    defaults(restoredDir, config.llm.model, config.app.context.systemPrompt),
  );
  const restoredServer = createHttpServer(restoredService);
  try {
    assert.equal(catalog.get<Turn>('turn', next.turn.id)?.answer, changed.answer);
    assert.equal(catalog.get<Job>('job', next.job.id)?.status, 'complete');
    assert.equal(catalog.list('user').length, 2);
    assert.equal(catalog.list('document').length, 4);
    assert.equal(catalog.db.prepare('SELECT count(*) AS n FROM originals').get()?.n, 5);
    restoredServer.listen(0, '127.0.0.1');
    await new Promise<void>((r) => restoredServer.once('listening', r));
    restoredService.start();
    const address = restoredServer.address();
    assert.ok(address && typeof address !== 'string');
    const restoredURL = 'http://127.0.0.1:' + address.port;
    assert.equal((await fetch(restoredURL + '/health/ready')).status, 200);
    const restoredAdmin = await restoredService.auth.login(
      'admin',
      'real-admin-password',
      'restored',
    );
    const sourceResponse = await fetch(
      restoredURL + `/api/documents/${source.document}?version=${source.version}`,
      { headers: { Authorization: 'Bearer ' + restoredAdmin.token } },
    );
    assert.equal(sourceResponse.status, 200);
    assert.equal(sourceResponse.headers.get('content-type'), 'application/pdf');
    const restoredFragment = (await restoredService.execute(
      'sources.read',
      { chunk: source.chunk },
      restoredService.auth.principal(restoredAdmin.token),
    )) as SourceDetails;
    assert.equal(restoredFragment.source.text, beforeReindex.source.text);
    const diagnostics = (await restoredService.execute(
      'diagnostics',
      {},
      restoredService.auth.principal(restoredAdmin.token),
    )) as { indexCompatible: boolean; dependencies: { embedding: boolean } };
    assert.equal(diagnostics.indexCompatible, true);
    assert.equal(diagnostics.dependencies.embedding, true);
    const postRestoreHits = await restoredService.searchSources(
      restoredService.auth.principal(restoredAdmin.token),
      'E-42',
      { collection: collection.id },
    );
    assert.equal(postRestoreHits[0]?.version, changed.sources[0]?.version);
    step('restored installation starts and serves sources/search', {
      ready: true,
      indexCompatible: diagnostics.indexCompatible,
      completedJobs: catalog.list<Job>('job').filter((j) => j.status === 'complete').length,
      savedSourceFragments: catalog.db.prepare('SELECT count(*) AS n FROM source_fragments').get()
        ?.n,
    });
  } finally {
    restoredServer.closeAllConnections();
    restoredServer.close();
    await restoredService.close();
  }
  step('backup and independent restore', restored);
  evidence.completed = new Date().toISOString();
  writeFileSync('docs/verification/live.json', JSON.stringify(evidence, null, 2));
  console.log('ALL LIVE PRODUCT CHECKS PASSED');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  server.close();
  await service.close();
  rmSync(directory, { recursive: true, force: true });
}
