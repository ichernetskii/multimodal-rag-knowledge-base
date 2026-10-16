import type { Page } from '../../contracts/public.js';

// Media filenames and timestamps are provenance, not a transcript or description.
export const hasSearchText = (page: Page) =>
  Boolean(page.text.trim()) &&
  (page.method === 'text' || page.method === 'ocr' || page.sections.some((s) => s.text.trim()));

export function presentPage(page: Page): Page {
  if (hasSearchText(page) || !page.preparedText) return page;
  return {
    ...page,
    text: page.preparedText.text,
    sections: [
      {
        title: page.preparedText.kind === 'transcript' ? 'Transcript' : 'Visual description',
        text: page.preparedText.text,
      },
    ],
    warnings: [...new Set([...page.warnings, 'AUTO_TEXT_REVIEW_REQUIRED'])],
  };
}
