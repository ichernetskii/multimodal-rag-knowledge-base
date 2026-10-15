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
/** Prepared IDs are passed unchanged from chunking to inference; they are not stored in SQLite. */
export interface TokenizedInput {
  readonly tokenIds: readonly number[];
  readonly tokenizerSignature: string;
}
export interface PreparedDocumentChunk extends DocumentChunk {
  tokens: TokenizedInput;
}
export interface EmbeddingModelInfo {
  model: string;
  digest: string;
  dimensions: number;
}
export interface EmbeddingBatch {
  vectors: Vector[];
  /** Number of real input IDs in the batch, excluding padding. */
  inputTokens?: number;
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
/** The model runner consumes IDs only. Tensor construction and padding belong to its adapter. */
export interface TokenEmbeddingModel {
  readonly signature: string;
  embed(tokenIds: readonly (readonly number[])[]): Promise<Vector[]>;
  close(): void | Promise<void>;
}
export interface EmbeddingProvider {
  describe(): Promise<EmbeddingModelInfo>;
  embed(inputs: readonly TokenizedInput[]): Promise<EmbeddingBatch>;
  close(): void | Promise<void>;
}
export interface ModelArtifacts {
  directory: string;
  fingerprint: string;
}
/** Provisioning is separate from inference: only prepare() may download files. */
export interface ModelArtifactRepository {
  prepare(): Promise<ModelArtifacts>;
  load(): Promise<ModelArtifacts>;
}
