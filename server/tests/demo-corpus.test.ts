import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { supportedExtensions, mediaKind } from '../src/shared/media-types.js';
import { extname } from 'node:path';

void test('demo corpus has intact, supported inputs and acceptance questions for every modality', async () => {
  const directory = new URL('../../examples/knowledge-base/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8')) as {
    materials: {
      path: string;
      sha256: string;
      bytes: number;
      kind: string;
      question: string;
      expected: string;
    }[];
  };
  assert.deepEqual([...new Set(manifest.materials.map((m) => m.kind))].sort(), [
    'audio',
    'image',
    'pdf',
    'text',
    'video',
  ]);
  assert.equal(new Set(manifest.materials.map((m) => m.path)).size, manifest.materials.length);
  for (const material of manifest.materials) {
    const bytes = await readFile(new URL(material.path, directory));
    assert.equal(bytes.length, material.bytes, material.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), material.sha256, material.path);
    assert.ok(supportedExtensions.includes(extname(material.path)));
    assert.ok(material.question.trim() && material.expected.trim());
    if (material.kind === 'pdf') assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    else if (material.kind === 'text')
      assert.ok(new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim());
    else assert.equal(mediaKind(material.path), material.kind);
    if (material.kind === 'video') assert.equal(bytes.subarray(4, 8).toString(), 'ftyp');
    if (material.kind === 'audio') assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
    if (material.kind === 'image') assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  }
});
