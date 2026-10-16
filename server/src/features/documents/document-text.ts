import type { DocumentMatch, DocumentPage, Page } from '../../contracts/public.js';
import { requireValue } from '../../shared/errors.js';
import { presentPage } from './material-text.js';

/** Offsets are UTF-16 positions, matching browser selection and correction ranges. */
export function pageWindow(stored: Page, offset: number, limit: number): DocumentPage {
  const page = presentPage(stored);
  requireValue(
    Number.isSafeInteger(offset) && offset >= 0 && offset <= page.text.length,
    'INVALID_INPUT',
    'Text offset is outside the page.',
  );
  requireValue(
    Number.isSafeInteger(limit) && limit >= 100 && limit <= 32000,
    'INVALID_INPUT',
    'Text window must contain 100–32000 characters.',
  );
  const lowSurrogate = (at: number) => {
    const code = page.text.charCodeAt(at);
    return code >= 0xdc00 && code <= 0xdfff;
  };
  const start = offset > 0 && lowSurrogate(offset) ? offset - 1 : offset;
  let end = Math.min(page.text.length, start + limit);
  if (end < page.text.length && lowSurrogate(end)) end--;
  const { text: preparedText, ...provenance } = page.preparedText ?? {};
  void preparedText;
  return {
    number: page.number,
    method: page.method,
    warnings: page.warnings,
    ...(page.media ? { media: page.media } : {}),
    ...(page.preparedText
      ? { preparedText: provenance as NonNullable<DocumentPage['preparedText']> }
      : {}),
    text: page.text.slice(start, end),
    offset: start,
    nextOffset: end,
    totalCharacters: page.text.length,
  };
}

export function findText(pages: Page[], query: string, skip: number, take: number) {
  requireValue(
    query.trim().length > 0 && query.length <= 200,
    'INVALID_INPUT',
    'Enter 1–200 characters to find.',
  );
  const expression = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu');
  const items: DocumentMatch[] = [];
  let total = 0,
    limited = false;
  for (const stored of pages) {
    const page = presentPage(stored);
    expression.lastIndex = 0;
    for (let match = expression.exec(page.text); match; match = expression.exec(page.text)) {
      if (total >= 10000) {
        limited = true;
        break;
      }
      if (total >= skip && items.length < take)
        items.push({
          page: page.number,
          offset: match.index,
          length: match[0].length,
          snippet: page.text.slice(
            Math.max(0, match.index - 50),
            match.index + match[0].length + 90,
          ),
        });
      total++;
    }
    if (limited) break;
  }
  return { items, total, limited };
}
