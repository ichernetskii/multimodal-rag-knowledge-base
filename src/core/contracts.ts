/** Stage contracts are independent of Ollama, SQLite, and Tokenizers.js. */
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
  /** The token count reported by the engine for the entire batch. */
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
export interface TokenCounter {
  count(text: string, options?: { includeSpecialTokens?: boolean }): number;
}
export interface EmbeddingFormatter {
  readonly signature: string;
  document(name: string, section: string, body: string): string;
  query(question: string): string;
}
export interface DocumentChunker {
  chunk(document: LoadedDocument, sections: readonly DocumentSection[]): Promise<DocumentChunk[]>;
}
export interface EmbeddingProvider {
  describe(): Promise<EmbeddingModelInfo>;
  embed(inputs: readonly string[]): Promise<EmbeddingBatch>;
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
