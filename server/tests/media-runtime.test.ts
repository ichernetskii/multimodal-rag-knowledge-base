import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { downloadVerified, digestFile } from '../src/infrastructure/media-runtime/download.js';
import { prepareMediaRuntime } from '../src/infrastructure/media-runtime/installer.js';
import { mediaBuildVersion } from '../src/infrastructure/media-runtime/manifest.js';
import { mediaCommand } from '../src/infrastructure/extraction/media-process.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
void test('processing rejects an outdated managed runtime and respects explicit executable configuration', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-media-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = {
    MEDIA_RUNTIME_DIR: process.env.MEDIA_RUNTIME_DIR,
    FFMPEG_BIN: process.env.FFMPEG_BIN,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.MEDIA_RUNTIME_DIR = dir;
  delete process.env.FFMPEG_BIN;
  assert.throws(() => mediaCommand('ffmpeg'), /не установлены/u);
  writeFileSync(
    join(dir, 'receipt.json'),
    JSON.stringify({ version: 'outdated', platform: process.platform, arch: process.arch }),
  );
  assert.throws(() => mediaCommand('ffmpeg'), /не соответствует/u);
  writeFileSync(
    join(dir, 'receipt.json'),
    JSON.stringify({ version: mediaBuildVersion, platform: process.platform, arch: process.arch }),
  );
  assert.equal(mediaCommand('ffmpeg'), join(dir, 'bin/ffmpeg'));
  process.env.FFMPEG_BIN = '/custom/ffmpeg';
  assert.equal(mediaCommand('ffmpeg'), '/custom/ffmpeg');
});
void test('managed downloads verify content, work offline and reject corruption without publishing partial files', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-media-assets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'tool'),
    asset = { url: 'https://example.invalid/tool', sha256: hash('valid-tool'), maxBytes: 20 };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('valid-tool');
  });
  assert.equal(await downloadVerified(path, asset), true);
  assert.equal(readFileSync(path, 'utf8'), 'valid-tool');
  assert.equal(await downloadVerified(path, asset, { offline: true }), false);
  assert.equal(calls, 1);
  writeFileSync(path, 'damaged');
  await assert.rejects(downloadVerified(path, asset, { offline: true }), /повреждён/u);
  assert.equal(calls, 1);
  t.mock.method(globalThis, 'fetch', async () => new Response('wrong-content'));
  await assert.rejects(downloadVerified(path, asset), /сумма/u);
  assert.equal(readFileSync(path, 'utf8'), 'damaged');
  assert.deepEqual(readdirSync(dir), ['tool']);
  t.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(21)));
  await assert.rejects(downloadVerified(path, asset), /лимит/u);
  assert.deepEqual(readdirSync(dir), ['tool']);
});
void test('a verified runtime is reusable on a read-only deployment; tampered executables fail check', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-media-install-')),
    bin = join(dir, 'runtime/bin');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(bin, { recursive: true });
  const files: Record<string, string> = {};
  for (const name of ['ffmpeg', 'ffprobe', 'whisper-cli']) {
    const path = join(bin, name);
    writeFileSync(path, 'verified ' + name, { mode: 0o755 });
    files[name] = await digestFile(path);
  }
  writeFileSync(
    join(dir, 'runtime/receipt.json'),
    JSON.stringify({
      version: mediaBuildVersion,
      platform: process.platform,
      arch: process.arch,
      files,
    }),
  );
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected network');
  });
  const options = {
    directory: join(dir, 'runtime'),
    modelPath: join(dir, 'weights.bin'),
    toolsOnly: true,
    offline: true,
    log: () => {},
  };
  assert.equal((await prepareMediaRuntime(options)).changed, false);
  assert.deepEqual(readdirSync(dir), ['runtime']);
  writeFileSync(join(bin, 'ffmpeg'), 'modified');
  await assert.rejects(prepareMediaRuntime({ ...options, check: true }), /повреждён/u);
});
void test('an installer waiting on another live process can be cancelled without removing its lock', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-media-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const modelPath = join(dir, 'weights.bin'),
    lock = modelPath + '.install-lock';
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(process.pid));
  const controller = new AbortController(),
    work = prepareMediaRuntime({
      directory: join(dir, 'runtime'),
      modelPath,
      signal: controller.signal,
      offline: true,
      log: () => {},
    });
  controller.abort(new Error('cancel test'));
  await assert.rejects(work, /cancel test/u);
  assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), String(process.pid));
});

void test('automatic installation refuses to replace unrelated directories or their contents', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-media-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const unrelated = join(dir, 'existing');
  mkdirSync(unrelated);
  writeFileSync(join(unrelated, 'important.txt'), 'keep');
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected network');
  });
  await assert.rejects(
    prepareMediaRuntime({
      directory: unrelated,
      modelPath: join(dir, 'weights.bin'),
      toolsOnly: true,
      offline: true,
      log: () => {},
    }),
    /существующие данные не изменены/u,
  );
  assert.equal(readFileSync(join(unrelated, 'important.txt'), 'utf8'), 'keep');
});
