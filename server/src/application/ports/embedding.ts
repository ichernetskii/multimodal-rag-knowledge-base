/** Stage contracts are independent of inference SDKs, tokenizers, and storage formats. */
export type Vector = readonly number[];
export interface LoadedDocument {
  name: string;
  format: 'markdown' | 'text';
  text: string;
}
export interface DocumentSection {
  title: string;
  text: string;
  startLine: number;
  endLine: number;
}
interface DocumentChunk {
  index: number;
  section: string;
  body: string;
  embeddingInput: string;
  tokenCount: number;
  startLine: number;
  endLine: number;
}
/** Prepared IDs are passed unchanged from chunking to inference; they are not persisted with source data. */
export interface TokenizedInput {
  readonly tokenIds: readonly number[];
  readonly tokenizerSignature: string;
}
export interface PreparedDocumentChunk extends DocumentChunk {
  tokens: TokenizedInput;
}
export interface DocumentParser {
  parse(document: Pick<LoadedDocument, 'format' | 'text'>): DocumentSection[];
}
export interface TextTokenizer {
  readonly signature: string;
  encode(text: string, options?: { includeSpecialTokens?: boolean }): TokenizedInput;
}
export interface EmbeddingFormatter {
  readonly signature: string;
  document(name: string, section: string, body: string): string;
  query(question: string): string;
}
export interface DocumentChunker {
  chunk(
    document: LoadedDocument,
    sections: readonly DocumentSection[],
    options?: { signal?: AbortSignal; maxChunks?: number },
  ): Promise<PreparedDocumentChunk[]>;
}
