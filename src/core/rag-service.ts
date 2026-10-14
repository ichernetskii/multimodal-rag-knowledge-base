import type {
  AnswerGenerator,
  ContextBuilder,
  DocumentChunker,
  DocumentLoader,
  DocumentParser,
  EmbeddingProvider,
  IndexedChunk,
  RagAnswer,
  Retriever,
  VectorStore,
} from './contracts.js';
import { hash } from './hash.js';

export interface RagStages {
  loader: DocumentLoader;
  parser: DocumentParser;
  chunker: DocumentChunker;
  embedder: EmbeddingProvider;
  store: VectorStore;
  retriever: Retriever;
  contextBuilder: ContextBuilder;
  generator: AnswerGenerator;
}

/** Connects stages through interfaces without importing implementation-specific libraries. */
export class RagService {
  constructor(
    private readonly stages: RagStages,
    private readonly batchSize: number,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1)
      throw new Error('Batch size must be a positive integer.');
  }
  async ingest(path: string) {
    const document = await this.stages.loader.load(path);
    const sections = this.stages.parser.parse(document);
    const chunks = await this.stages.chunker.chunk(document, sections);
    const records: IndexedChunk[] = [];
    for (let offset = 0; offset < chunks.length; offset += this.batchSize) {
      const batch = chunks.slice(offset, offset + this.batchSize);
      const { vectors } = await this.stages.embedder.embed(batch.map((chunk) => chunk.tokens));
      if (vectors.length !== batch.length)
        throw new Error('The number of embeddings does not match the number of chunks.');
      batch.forEach((chunk, index) => {
        const vector = vectors[index];
        if (!vector) throw new Error('A chunk embedding vector is missing.');
        records.push({ ...chunk, vector });
      });
    }
    const generation = hash(
      JSON.stringify({
        contentHash: document.contentHash,
        inputs: chunks.map((chunk) => chunk.embeddingInput),
      }),
    );
    // Compute every embedding before starting the storage transaction.
    await this.stages.store.replaceDocument(
      { id: document.id, path: document.path, name: document.name, generation },
      records,
    );
    return { documentId: document.id, source: document.name, chunks: records.length, generation };
  }
  search(question: string) {
    return this.stages.retriever.retrieve(question);
  }
  async ask(question: string): Promise<RagAnswer> {
    const hits = await this.search(question);
    if (!hits.length)
      return { answer: 'The documents do not contain enough information.', sources: [], hits };
    const context = this.stages.contextBuilder.build(question, hits);
    return {
      answer: await this.stages.generator.generate(context),
      sources: context.sources,
      hits,
    };
  }
  async close(): Promise<void> {
    try {
      await this.stages.store.close();
    } finally {
      await this.stages.embedder.close();
    }
  }
}
