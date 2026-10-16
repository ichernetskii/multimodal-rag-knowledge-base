import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from '../src/contracts/public.js';
import { pageWindow, findText } from '../src/features/documents/document-text.js';
const page = (text: string, number = 1): Page => ({
  number,
  text,
  method: 'text',
  warnings: [],
  sections: [],
});
void test('large Unicode text windows are bounded and do not split a surrogate pair', () => {
  const original = page('a'.repeat(99) + '🔧' + 'Я'.repeat(40000));
  const first = pageWindow(original, 0, 100);
  assert.equal(first.text.length, 99);
  assert.equal(first.nextOffset, 99);
  const second = pageWindow(original, first.nextOffset, 100);
  assert.ok(second.text.startsWith('🔧'));
  assert.equal(first.text + second.text, original.text.slice(0, second.nextOffset));
  assert.equal(pageWindow(original, 100, 100).offset, 99);
  assert.throws(() => pageWindow(original, -1, 100));
  assert.throws(() => pageWindow(original, 0, 50000));
});
void test('text windows omit duplicate full transcripts while retaining provenance', () => {
  const media: Page = {
    ...page('audio.wav'),
    method: 'speech',
    preparedText: {
      text: 'speech '.repeat(10000),
      kind: 'transcript',
      model: 'model',
      profile: 'profile',
      provider: 'google',
      created: 1,
    },
  };
  const part = pageWindow(media, 0, 100);
  assert.equal(part.totalCharacters, 70000);
  assert.equal(part.preparedText?.model, 'model');
  assert.equal('text' in (part.preparedText ?? {}), false);
  assert.ok(JSON.stringify(part).length < 1000);
});
void test('literal document search returns every occurrence, stable offsets, snippets and pagination', () => {
  const pages = [page('Pump P-204, pump P-204. A+B?'), page('Насос P-204. НАСОС.', 2)];
  const result = findText(pages, 'p-204', 1, 2);
  assert.equal(result.total, 3);
  assert.deepEqual(
    result.items.map((item) => [item.page, item.offset]),
    [
      [1, 17],
      [2, 6],
    ],
  );
  assert.equal(findText(pages, 'Насос', 0, 10).total, 2);
  assert.equal(findText(pages, 'A+B?', 0, 10).total, 1);
  assert.equal(findText(pages, 'missing', 0, 10).total, 0);
  assert.throws(() => findText(pages, ' ', 0, 10));
});
void test('very broad document searches have a bounded result count and disclose the limit', () => {
  const result = findText([page('x'.repeat(10001))], 'x', 0, 20);
  assert.equal(result.total, 10000);
  assert.equal(result.items.length, 20);
  assert.equal(result.limited, true);
});
