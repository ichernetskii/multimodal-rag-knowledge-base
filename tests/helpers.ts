import type {
  DocumentChunk,
  IndexedChunk,
  LoadedDocument,
  PreparedDocumentChunk,
  SearchHit,
  StoredDocument,
  TextTokenizer,
} from '../src/core/contracts.js';
import { hash } from '../src/core/hash.js';

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
    id: 'document',
    name: format === 'text' ? 'test.txt' : 'test.md',
    path: '/test/document.md',
    format,
    text,
    contentHash: hash(text),
  };
}
export const storedDocument = (id = 'a', generation = 'v1'): StoredDocument => ({
  id,
  name: id + '.md',
  path: '/test/' + id + '.md',
  generation,
});
export const vector = (axis = 0) => [0, 1, 2].map((index) => (index === axis ? 1 : 0));
export const chunk = (body = 'Text', index = 0, axis = 0): IndexedChunk & PreparedDocumentChunk => {
  const tokens = wordTokenizer.encode(body);
  return {
    index,
    body,
    embeddingInput: body,
    section: 'Section',
    tokenCount: tokens.tokenIds.length,
    tokens,
    startLine: 1,
    endLine: 3,
    vector: vector(axis),
  };
};
export function hit(body: string, id = 1): SearchHit {
  const item: DocumentChunk = chunk(body);
  return { id, document: storedDocument(), chunk: item, score: 1, distance: 0 };
}
