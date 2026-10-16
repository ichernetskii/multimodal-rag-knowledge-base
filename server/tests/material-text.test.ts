import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from '../src/contracts/public.js';
import { hasSearchText, presentPage } from '../src/features/documents/material-text.js';

void test('technical media labels cannot stand in for reviewed text when switching to text embeddings', () => {
  for (const method of ['vision', 'speech'] as const) {
    const page: Page = {
      number: 1,
      method,
      text: 'recording.mp4: audio 0–11 s',
      sections: [],
      warnings: [],
    };
    assert.equal(hasSearchText(page), false);
    assert.equal(
      hasSearchText({
        ...page,
        text: 'Turn off the pump.',
        sections: [{ title: 'Transcript', text: 'Turn off the pump.' }],
      }),
      true,
    );
    assert.equal(
      hasSearchText({ ...page, text: '', sections: [{ title: 'Transcript', text: '' }] }),
      false,
    );
  }
  for (const method of ['ocr', 'text'] as const)
    assert.equal(
      hasSearchText({ number: 1, method, text: 'Turn off the pump.', sections: [], warnings: [] }),
      true,
    );
});
void test('saved media text is reusable independently of the selected embedding model and cannot override reviewed text', () => {
  const page: Page = {
    number: 1,
    method: 'vision',
    text: 'photo.png',
    sections: [],
    warnings: [],
    preparedText: {
      text: 'Pump P-204, pressure 2 bar.',
      kind: 'description',
      profile: 'caption-profile',
      model: 'vision-model',
      provider: 'google',
      created: 1,
    },
  };
  assert.equal(hasSearchText(page), false);
  assert.equal(hasSearchText(presentPage(page)), true);
  assert.equal(presentPage(page).text, 'Pump P-204, pressure 2 bar.');
  assert.equal(page.text, 'photo.png');
  const reviewed = {
    ...page,
    text: 'Human-checked pump P-204.',
    sections: [{ title: 'Reviewed', text: 'Human-checked pump P-204.' }],
  };
  assert.equal(presentPage(reviewed).text, reviewed.text);
});
