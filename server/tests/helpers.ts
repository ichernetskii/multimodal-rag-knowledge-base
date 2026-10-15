import type { LoadedDocument, TextTokenizer } from '../src/application/ports/embedding.js';

export function testTokenizer(
  count: (text: string, options?: { includeSpecialTokens?: boolean }) => number,
): TextTokenizer {
  return {
    signature: 'test-tokenizer',
    encode: (text, options) => ({
      tokenizerSignature: 'test-tokenizer',
      tokenIds: Array.from({ length: count(text, options) }, (_value, index) => index + 3),
    }),
  };
}
export const wordTokenizer = testTokenizer(
  (text, options) =>
    text.trim().split(/\s+/u).filter(Boolean).length +
    (options?.includeSpecialTokens === false ? 0 : 1),
);
export function document(
  text: string,
  format: LoadedDocument['format'] = 'markdown',
): LoadedDocument {
  return {
    name: format === 'text' ? 'test.txt' : 'test.md',

    format,
    text,
  };
}
