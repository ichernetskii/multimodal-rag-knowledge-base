import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { contractSignature } from '../server/src/contracts/format.generated.ts';
import type {
  ActionName,
  ActionInputs,
  ActionResults,
  DocumentDetails,
} from '../server/src/contracts/public.ts';
const project = 'rag-test-saas-' + Date.now().toString(36),
  directory = await mkdtemp(resolve(tmpdir(), 'rag-docker-'));
const net = createServer();
await new Promise<void>((r) => net.listen(0, '127.0.0.1', r));
const address = net.address();
assert.ok(address && typeof address === 'object');
const port = address.port;
await new Promise<void>((r) => net.close(() => r()));
const origin = 'http://127.0.0.1:' + port,
  env = {
    ...process.env,
    NODE_ENV: 'development',
    ALLOW_TEST_AI: '1',
    DEFAULT_GENERATION_PROVIDER: 'test',
    DEFAULT_EMBEDDING_PROVIDER: 'test',
    HTTP_PORT: String(port),
    HTTP_BIND: '127.0.0.1',
    DOCKER_PUBLIC_ORIGIN: origin,
  };
const docker = process.env.DOCKER_BIN ?? 'docker',
  base = ['compose', '--env-file', '.env', '-p', project, '--profile', 'app'];
const evidence: {
  at: string;
  project: string;
  steps: { name: string; ms: number }[];
  success: boolean;
  error?: string;
} = { at: new Date().toISOString(), project, steps: [], success: false };
async function run(args: string[], input?: string) {
  return new Promise<string>((r, j) => {
    const child = spawn(docker, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '',
      errors = '';
    child.stdout.on('data', (b: Buffer) => {
      output = (output + b.toString()).slice(-2000000);
    });
    child.stderr.on('data', (b: Buffer) => {
      errors = (errors + b.toString()).slice(-10000);
    });
    child.once('error', j);
    child.once('exit', (code) =>
      code === 0
        ? r(output)
        : j(
            new Error(
              'Docker command failed: ' + code + '\n' + errors + '\n' + output.slice(-3000),
            ),
          ),
    );
    child.stdin.end(input);
  });
}
const compose = (args: string[], input?: string) => run([...base, ...args], input);
async function waitForApiReadiness() {
  let lastStatus = 'not reachable';
  for (const deadline = Date.now() + 60000; Date.now() < deadline;) {
    try {
      const response = await fetch(origin + '/health/ready', {
        signal: AbortSignal.timeout(2000),
      });
      await response.body?.cancel();
      if (response.ok) return;
      lastStatus = 'HTTP ' + response.status;
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('API did not become ready after restart: ' + lastStatus);
}
async function step(name: string, work: () => Promise<void>) {
  const start = performance.now();
  await work();
  evidence.steps.push({ name, ms: Math.round(performance.now() - start) });
  console.log('PASS: ' + name);
}
let token = '',
  tenant = '';
async function api<N extends ActionName>(
  action: N,
  input: ActionInputs[N],
): Promise<ActionResults[N]> {
  const r = await fetch(origin + '/api/actions/' + action, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      'X-Tenant-ID': tenant,
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(120000),
  });
  const value = (await r.json()) as ActionResults[N];
  assert.ok(r.ok, JSON.stringify(value));
  return value;
}
async function wait(id: string) {
  const until = Date.now() + 180000;
  while (Date.now() < until) {
    const job = await api('jobs.read', { id });
    if (['failed', 'cancelled', 'interrupted'].includes(job.status))
      throw new Error(JSON.stringify(job));
    if (['complete', 'no_info'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Job timed out: ' + id);
}
async function upload(name: string, data: Buffer, collection: string) {
  const session = await api('uploads.create', {
    name,
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    collection,
  });
  for (let offset = 0; offset < data.length; offset += session.partBytes) {
    const r = await fetch(origin + '/api/uploads/' + session.id, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + token,
        'X-Tenant-ID': tenant,
        'Upload-Offset': String(offset),
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(data.subarray(offset, offset + session.partBytes)),
    });
    assert.ok(r.ok, await r.text());
  }
  const result = await api('documents.upload', { upload: session.id });
  assert.ok(result.job);
  await wait(result.job.id);
  const detail = await api('documents.read', { id: result.document.id });
  await wait(
    (
      await api('documents.publish', {
        id: detail.document.id,
        revision: detail.document.revision,
        version: detail.version.id,
        acknowledge: true,
      })
    ).id,
  );
  return detail;
}
try {
  if (!process.argv.includes('--no-build'))
    await step('build images', async () => {
      await compose(['build', 'api', 'client']);
    });
  await step('cold Compose deployment', async () => {
    await compose(['up', '-d', '--wait']);
  });
  await step('operator bootstrap, HTTP authentication and two companies', async () => {
    await compose(
      [
        'exec',
        '-T',
        'api',
        'node',
        'server/dist/interfaces/cli/main.js',
        'bootstrap',
        'test-admin',
        '--name',
        'Acceptance A',
      ],
      'acceptance-password',
    );
    const r = await fetch(origin + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ login: 'test-admin', password: 'acceptance-password', cli: true }),
    });
    const value = (await r.json()) as { token: string; user: { tenant: string } };
    assert.equal(r.status, 200);
    token = value.token;
    tenant = value.user.tenant;
    await api('tenants.create', { name: 'Acceptance B' });
  });
  let document: DocumentDetails | undefined;
  const kb = await api('collections.save', { name: 'Manuals', grants: [] });
  await step('multipart upload, review, index and search', async () => {
    document = await upload(
      'policy.txt',
      Buffer.from(
        'Vacation must be requested 14 calendar days in advance. XZ-417 service interval: 60 days.',
      ),
      kb.id,
    );
    assert.ok((await api('search', { question: 'Vacation' })).length);
  });
  await step('queue survives API restart while answer worker is stopped; SSE resumes', async () => {
    await compose(['stop', 'worker-answers']);
    const c = await api('conversations.create', {});
    const input = {
      conversation: c.id,
      revision: c.revision,
      question: 'When must vacation be requested?',
      idempotencyKey: randomUUID(),
    };
    const accepted = await api('answers.create', input);
    assert.equal((await api('answers.create', input)).job.id, accepted.job.id);
    await compose(['restart', 'api']);
    await waitForApiReadiness();
    await compose(['start', 'worker-answers']);
    await wait(accepted.job.id);
    const response = await fetch(origin + '/api/events/' + accepted.job.id, {
      headers: { Authorization: 'Bearer ' + token, 'X-Tenant-ID': tenant, 'Last-Event-ID': '1' },
    });
    const sse = await response.text();
    assert.match(sse, /event: snapshot/);
    assert.match(sse, /14 calendar/);
    assert.match(sse, /\[TEST AI\]/);
  });
  await step('PDF/OCR, image, audio and video with real bundled tools', async () => {
    for (const name of ['text.pdf', 'scan.pdf', 'mixed.pdf', 'tables.pdf']) {
      const pdf = await upload(name, await readFile('examples/knowledge-base/pdf/' + name), kb.id);
      const pages = await Promise.all(
        pdf.pages.map((page) =>
          api('documents.page', {
            id: pdf.document.id,
            version: pdf.version.id,
            page: page.number,
          }),
        ),
      );
      assert.ok(pages.length > 0);
      assert.ok(pages.some((page) => page.media?.kind === 'image'));
      if (name === 'scan.pdf' || name === 'mixed.pdf')
        assert.ok(pages.some((page) => page.method === 'ocr'));
    }
    await upload('label.png', await readFile('examples/knowledge-base/media/label.png'), kb.id);
    const profiles = await api('models.list', {});
    const whisper = profiles.find((p) => p.provider === 'whisper')!;
    await api('models.save', { profile: { ...whisper, enabled: true } });
    const settings = await api('settings.read', {});
    await api('settings.save', {
      revision: settings.revision,
      settings: { transcriptionProfile: whisper.id },
    });
    const audio = await upload(
      'speech.wav',
      await readFile('examples/knowledge-base/media/jfk.wav'),
      kb.id,
    );
    assert.match(
      (await api('documents.page', { id: audio.document.id, version: audio.version.id, page: 1 }))
        .text,
      /country/i,
    );
    const video = await upload(
      'inspection.mp4',
      await readFile('examples/knowledge-base/media/inspection.mp4'),
      kb.id,
    );
    const videoPages = await Promise.all(
      video.pages.map((page) =>
        api('documents.page', {
          id: video.document.id,
          version: video.version.id,
          page: page.number,
        }),
      ),
    );
    assert.ok(videoPages.some((p) => p.media?.kind === 'video'));
    assert.ok(videoPages.some((p) => p.media?.kind === 'audio'));
    assert.ok(
      videoPages.some((p) => p.media?.kind === 'video' && (p.media.startMs ?? 0) === 12000),
    );
  });
  await step(
    'demo importer uploads and publishes every checked-in modality through the public API',
    async () => {
      const session = resolve(directory, 'cli.json');
      await writeFile(
        session,
        JSON.stringify({ format: contractSignature, url: origin, token, tenant }),
        { mode: 0o600 },
      );
      await new Promise<void>((done, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', 'tooling/import-demo.ts', '--publish'],
          {
            env: { ...process.env, RAG_CLI_FILE: session },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let output = '';
        for (const stream of [child.stdout, child.stderr])
          stream.on('data', (part: Buffer) => {
            output = (output + part.toString()).slice(-20000);
          });
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? done() : reject(new Error(output))));
      });
      const imported = (await api('collections.list', {})).find((collection) =>
        collection.name.startsWith('Sample knowledge base · '),
      );
      assert.ok(imported);
      assert.equal(imported.documentCount, 9);
      const materials = await api('documents.list', {
        scope: { collection: imported.id },
        pageSize: 100,
      });
      assert.equal(materials.total, 9);
      assert.ok(materials.items.every((document) => document.state === 'published'));
    },
  );
  await step('published correction stays isolated until review and activation', async () => {
    const before = await api('documents.read', { id: document!.document.id });
    await wait(
      (
        await api('documents.revise', {
          id: before.document.id,
          revision: before.document.revision,
          version: before.version.id,
        })
      ).id,
    );
    const candidate = await api('documents.read', { id: before.document.id });
    assert.equal(candidate.version.state, 'review');
    assert.equal(candidate.document.activeVersion, before.version.id);
    const source = await api('documents.page', {
      id: before.document.id,
      version: before.version.id,
      page: 1,
    });
    const correction = await api('documents.correct', {
      id: before.document.id,
      revision: candidate.document.revision,
      version: candidate.version.id,
      page: 1,
      text: source.text + '\nReviewed correction fixture.',
    });
    assert.equal(
      (await api('documents.page', { id: before.document.id, version: before.version.id, page: 1 }))
        .text,
      source.text,
    );
    await wait(
      (
        await api('documents.publish', {
          id: before.document.id,
          revision: correction.revision,
          version: candidate.version.id,
          acknowledge: true,
        })
      ).id,
    );
    assert.equal(
      (await api('documents.read', { id: before.document.id })).document.activeVersion,
      candidate.version.id,
    );
  });
  await step('Redis outage leaves PostgreSQL queue and search usable', async () => {
    await compose(['stop', 'redis']);
    try {
      const result = await api('search', { question: 'XZ-417' });
      assert.ok(result.length);
    } finally {
      await compose(['start', 'redis']);
    }
  });
  await step('tenant backup, deletion and targeted restore', async () => {
    await wait((await api('backup.create', {})).id);
    const backups = await api('backup.list', {});
    await api('backup.verify', { id: backups[0]!.id });
    const detail = await api('documents.read', { id: document!.document.id });
    await api('documents.delete', { id: detail.document.id, revision: detail.document.revision });
    await wait((await api('backup.restore', { id: backups[0]!.id })).id);
    assert.ok(await api('documents.read', { id: detail.document.id }));
  });
  await step('private S3 denies anonymous access', async () => {
    const status = await compose([
      'exec',
      '-T',
      'api',
      'node',
      '-e',
      "fetch(process.env.S3_ENDPOINT+'/'+process.env.S3_BUCKET+'?list-type=2').then(r=>console.log(r.status))",
    ]);
    assert.equal(Number(status.trim()), 403);
  });
  await step('dependency diagnostics', async () => {
    const d = await api('diagnostics', {});
    assert.equal(d.media.ffmpeg, true);
    assert.equal(d.media.whisper, true);
    assert.equal(d.media.model, true);
    assert.equal(d.extraction.pdf, true);
  });
  evidence.success = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(evidence.error);
  process.exitCode = 1;
} finally {
  await mkdir('.artifacts/verification', { recursive: true });
  await writeFile('.artifacts/verification/docker.json', JSON.stringify(evidence, null, 2) + '\n');
  if (process.env.KEEP_DOCKER_TEST !== '1') {
    await compose(['down', '--volumes', '--remove-orphans']);
    await rm(directory, { recursive: true, force: true });
  } else console.log('Retained isolated test project: ' + project + '\nBrowser: ' + origin);
}
