import type { RuntimeConfig } from './runtime-config.js';
import { FileDocumentLoader } from './documents/file-loader.js';
import { TextDocumentParser } from './documents/parser.js';
import { loadTokenizer, prepareTokenizer } from './tokenization/huggingface-tokenizer.js';
import { TokenDocumentChunker } from './chunking/token-chunker.js';
import { EmbeddingGemmaFormatter } from './embeddings/formatter.js';
import { OllamaEmbeddingProvider } from './embeddings/ollama-embedder.js';
import { createOllamaClient, requireModel } from './ollama/client.js';
import { SqliteVectorStore } from './storage/sqlite-store.js';
import { VectorRetriever } from './retrieval/vector-retriever.js';
import { SourcesContextBuilder } from './generation/context-builder.js';
import { OllamaAnswerGenerator } from './generation/ollama-generator.js';
import { RagService } from './core/rag-service.js';
import type { RagStages } from './core/rag-service.js';

/** The single place where stage implementations are selected and connected. */
export async function createApplication(config: RuntimeConfig, createStore = true) {
  const { tokenizer, fingerprint } = await loadTokenizer(config.tokenizer);
  const client = createOllamaClient(config.ollama);
  const formatter = new EmbeddingGemmaFormatter(config.embedding);
  const embedder = new OllamaEmbeddingProvider(client, config.embedding, config.ollama, tokenizer);
  const model = await embedder.describe();
  const signature = JSON.stringify({
    model,
    tokenizer: {
      repository: config.tokenizer.repository,
      revision: config.tokenizer.revision,
      fingerprint,
    },
    formatting: formatter.signature,
    maxTokens: config.embedding.maxTokens,
  });
  const store = new SqliteVectorStore(config.storage.path, {
    dimensions: model.dimensions,
    signature,
    create: createStore,
    readOnly: !createStore,
  });
  const stages: RagStages = {
    loader: new FileDocumentLoader(config.app.documents.maxBytes),
    parser: new TextDocumentParser(),
    chunker: new TokenDocumentChunker(
      tokenizer,
      formatter,
      config.app.chunking,
      config.embedding.maxTokens - config.embedding.tokenSafetyMargin,
    ),
    embedder,
    store,
    retriever: new VectorRetriever(formatter, embedder, store, config.app.retrieval),
    contextBuilder: new SourcesContextBuilder(config.app.context),
    generator: new OllamaAnswerGenerator(client, config.llm, config.ollama.keepAlive),
  };
  return {
    rag: new RagService(stages, config.app.indexing.batchSize),
    stages,
    tokenizer,
    formatter,
    client,
    model,
  };
}

export async function setupApplication(config: RuntimeConfig) {
  await prepareTokenizer(config.tokenizer);
  const client = createOllamaClient(config.ollama);
  try {
    await requireModel(client, config.embedding.model);
  } catch (error) {
    // Propagate network errors without attempting a model download.
    if (!(error instanceof Error) || !error.message.startsWith('Model ')) throw error;
    await client.pull({ model: config.embedding.model, stream: false });
  }
  return { tokenizerDirectory: config.tokenizer.directory, embeddingModel: config.embedding.model };
}

export async function checkApplication(config: RuntimeConfig, storageOnly = false) {
  const store = new SqliteVectorStore(':memory:', {
    dimensions: config.embedding.dimensions,
    signature: 'storage-check',
  });
  let storage;
  try {
    storage = await store.stats();
  } finally {
    store.close();
  }
  if (storageOnly) return { storage };
  const { tokenizer } = await loadTokenizer(config.tokenizer);
  const client = createOllamaClient(config.ollama);
  await requireModel(client, config.llm.model);
  const embedder = new OllamaEmbeddingProvider(client, config.embedding, config.ollama, tokenizer);
  const model = await embedder.describe();
  const input = new EmbeddingGemmaFormatter(config.embedding).query('Local embedding check');
  const result = await embedder.embed([input]);
  return {
    storage,
    model,
    localTokenCount: tokenizer.count(input),
    ollamaTokenCount: result.inputTokens,
    llmModel: config.llm.model,
  };
}
