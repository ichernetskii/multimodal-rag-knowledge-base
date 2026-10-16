import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaults } from '../src/config/default-settings.js';
import { extract } from '../src/infrastructure/extraction/extract.js';
void test('cancelling extraction terminates its child process group and removes all owned temporary files', async (t) => {
  if (process.platform === 'win32') return;
  const directory = mkdtempSync(join(tmpdir(), 'rag-pdf-cancel-')),
    script = join(directory, 'extract.mjs'),
    controller = new AbortController(),
    settings = { ...defaults(), dataDir: directory, whisperModel: '' };
  writeFileSync(
    script,
    "import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';import {dirname,join} from 'node:path';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(join(dirname(process.argv[2]),'child.pid'),String(child.pid));console.log(JSON.stringify({progress:'ocr'}));setInterval(()=>{},1000);",
  );
  const previousPython = process.env.PDF_PYTHON,
    previousScript = process.env.PDF_EXTRACT_SCRIPT;
  process.env.PDF_PYTHON = process.execPath;
  process.env.PDF_EXTRACT_SCRIPT = script;
  t.after(() => {
    if (previousPython === undefined) delete process.env.PDF_PYTHON;
    else process.env.PDF_PYTHON = previousPython;
    if (previousScript === undefined) delete process.env.PDF_EXTRACT_SCRIPT;
    else process.env.PDF_EXTRACT_SCRIPT = previousScript;
    rmSync(directory, { recursive: true, force: true });
  });
  let pid = 0;
  await assert.rejects(
    extract('test.pdf', Buffer.from('%PDF-1.7\n'), settings, controller.signal, () => {
      const folder = readdirSync(directory).find((name) => name.startsWith('extract-'))!;
      pid = Number(readFileSync(join(directory, folder, 'child.pid'), 'utf8'));
      controller.abort();
    }),
  );
  assert.ok(pid > 0);
  for (let attempt = 0; attempt < 40; attempt++) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (!alive) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.throws(() => process.kill(pid, 0));
  assert.ok(!readdirSync(directory).some((name) => name.startsWith('extract-')));
});
