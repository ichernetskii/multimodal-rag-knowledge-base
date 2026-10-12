import type {
  EmbeddingFormatter,
  EmbeddingProvider,
  Retriever,
  SearchHit,
  SearchOptions,
  VectorStore,
} from '../core/contracts.js';

export class VectorRetriever implements Retriever {
  constructor(
    private readonly formatter: EmbeddingFormatter,
    private readonly embedder: EmbeddingProvider,
    private readonly store: VectorStore,
    private readonly options: SearchOptions,
  ) {}
  async retrieve(question: string): Promise<SearchHit[]> {
    if (!question.trim()) throw new Error('The question must not be empty.');
    const { vectors } = await this.embedder.embed([this.formatter.query(question)]);
    const vector = vectors[0];
    if (!vector) throw new Error('The embedding model did not return a question vector.');
    return this.store.search(vector, this.options);
  }
}
