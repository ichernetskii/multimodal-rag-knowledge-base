/** Stage contracts are independent of inference SDKs, tokenizers, and storage formats. */
export type Vector = readonly number[];
export interface LoadedDocument {
  id: string;
  path: string;
  name: string;
  format: 'markdown' | 'text';
  text: string;
  contentHash: string;
}
export interface DocumentSection {
  title: string;
  text: string;
  startLine: number;
  endLine: number;
}
export interface DocumentChunk {
  index: number;
  section: string;
  body: string;
  embeddingInput: string;
  tokenCount: number;
  startLine: number;
  endLine: number;
}
export interface IndexedChunk extends DocumentChunk {
  vector: Vector;
}
/** Prepared IDs are passed unchanged from chunking to inference; they are not stored in SQLite. */
export interface TokenizedInput {
  readonly tokenIds: readonly number[];
  readonly tokenizerSignature: string;
}
export interface PreparedDocumentChunk extends DocumentChunk {
  tokens: TokenizedInput;
}
export interface StoredDocument {
  id: string;
  path: string;
  name: string;
  generation: string;
}
export interface SearchHit {
  id: number;
  score: number;
  distance: number;
  document: StoredDocument;
  chunk: DocumentChunk;
}
export interface SourceReference {
  id: number;
  documentId: string;
  name: string;
  section: string;
  text: string;
}
export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}
export interface AnswerContext {
  messages: ChatMessage[];
  sources: SourceReference[];
}
export interface RagAnswer {
  answer: string;
  sources: SourceReference[];
  hits: SearchHit[];
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
export interface StoreStats {
  documents: number;
  chunks: number;
  vectors: number;
}
export interface SearchOptions {
  limit: number;
  minScore?: number;
}
export interface DocumentLoader {
  load(path: string): Promise<LoadedDocument>;
}
export interface DocumentParser {
  parse(document: LoadedDocument): DocumentSection[];
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
export interface VectorStore {
  replaceDocument(document: StoredDocument, chunks: readonly IndexedChunk[]): Promise<void>;
  search(vector: Vector, options: SearchOptions): Promise<SearchHit[]>;
  stats(): Promise<StoreStats>;
  close(): void | Promise<void>;
}
export interface Retriever {
  retrieve(question: string): Promise<SearchHit[]>;
}
export interface ContextBuilder {
  build(question: string, hits: readonly SearchHit[]): AnswerContext;
}
export interface AnswerGenerator {
  generate(context: AnswerContext): Promise<string>;
}
