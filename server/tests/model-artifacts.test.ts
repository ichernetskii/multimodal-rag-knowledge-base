import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import test from 'node:test';
import { HuggingFaceModelRepository } from '../src/infrastructure/models/model-artifacts.js';
import { hash } from '../src/shared/hash.js';

const data = '{"test":true}';
const asset = { name: 'config.json', bytes: Buffer.byteLength(data), sha256: hash(data) };
async function repository(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rag-model-assets-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    files: new HuggingFaceModelRepository({
      directory,
      repository: 'test/model',
      revision: 'pinned',
      downloadTimeoutMs: 1000,
      assets: [asset],
    }),
  };
}

void test('Working model loading checks local integrity without any network requests', async (context) => {
  const { directory, files } = await repository(context);
  context.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected network request');
  });
  await assert.rejects(files.load(), /Run yarn cli setup/u);
  await writeFile(join(directory, asset.name), data);
  const result = await files.load();
  assert.equal(result.directory, directory);
  assert.equal(result.fingerprint.length, 64);
});

void test('Setup repairs corrupt files, then skips downloading already verified assets', async (context) => {
  const { directory, files } = await repository(context);
  let requests = 0;
  context.mock.method(globalThis, 'fetch', (input: string | URL | Request) => {
    requests++;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    assert.match(url, /\/resolve\/pinned\/config.json$/u);
    return Promise.resolve(new Response(data));
  });
  await writeFile(join(directory, asset.name), 'corrupt');
  await assert.rejects(files.load(), /does not match/u);
  const first = await files.prepare();
  const second = await files.prepare();
  assert.deepEqual(first, second);
  assert.equal(requests, 1);
  assert.equal(await readFile(join(directory, asset.name), 'utf8'), data);
});

void test('An invalid download preserves the previous file and removes temporary files', async (context) => {
  const { directory, files } = await repository(context);
  await writeFile(join(directory, asset.name), 'previous');
  context.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(data.length)));
  await assert.rejects(files.prepare(), /does not match/u);
  assert.equal(await readFile(join(directory, asset.name), 'utf8'), 'previous');
  assert.deepEqual(await readdir(directory), [asset.name]);
});

void test('Oversized downloads and HTTP failures never publish a model file', async (context) => {
  const { directory, files } = await repository(context);
  context.mock.method(globalThis, 'fetch', async () => new Response(data + 'extra'));
  await assert.rejects(files.prepare(), /exceeds/u);
  assert.deepEqual(await readdir(directory), []);
  context.mock.method(
    globalThis,
    'fetch',
    async () => new Response('Unavailable', { status: 503 }),
  );
  await assert.rejects(files.prepare(), /HTTP 503/u);
  assert.deepEqual(await readdir(directory), []);
});

void test('Artifact names cannot escape the selected model directory', () => {
  assert.throws(
    () =>
      new HuggingFaceModelRepository({
        directory: '/tmp/model',
        repository: 'test/model',
        revision: 'pinned',
        downloadTimeoutMs: 1000,
        assets: [{ ...asset, name: '../outside' }],
      }),
    /path/u,
  );
});

void test('An interrupted download removes its temporary file and preserves the previous asset', async (context) => {
  const { directory, files } = await repository(context);
  await writeFile(join(directory, asset.name), 'previous');
  let reads = 0;
  context.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (reads++ === 0) controller.enqueue(new TextEncoder().encode('partial'));
            else controller.error(new Error('Interrupted download'));
          },
        }),
      ),
  );
  await assert.rejects(files.prepare(), /Interrupted/u);
  assert.equal(await readFile(join(directory, asset.name), 'utf8'), 'previous');
  assert.deepEqual(await readdir(directory), [asset.name]);
});
