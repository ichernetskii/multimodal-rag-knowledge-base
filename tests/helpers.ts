import type {
  DocumentChunk,
  IndexedChunk,
  LoadedDocument,
  SearchHit,
  StoredDocument,
  TokenCounter,
} from '../src/core/contracts.js';
import { hash } from '../src/core/hash.js';

export const wordCounter: TokenCounter = {
  count: (text) => text.trim().split(/\s+/u).filter(Boolean).length + 1,
};
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
  name: `${id}.md`,
  path: `/test/${id}.md`,
  generation,
});
export const vector = (axis = 0) => [0, 1, 2].map((index) => (index === axis ? 1 : 0));
export const chunk = (body = 'Text', index = 0, axis = 0): IndexedChunk => ({
  index,
  body,
  embeddingInput: body,
  section: 'Section',
  tokenCount: 5,
  startLine: 1,
  endLine: 3,
  vector: vector(axis),
});
export function hit(body: string, id = 1): SearchHit {
  const item: DocumentChunk = chunk(body);
  return { id, document: storedDocument(), chunk: item, score: 1, distance: 0 };
}
