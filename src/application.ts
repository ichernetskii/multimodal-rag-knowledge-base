import type { RuntimeConfig } from './runtime-config.js';
import type { ModelArtifactRepository } from './core/contracts.js';
import { FileDocumentLoader } from './documents/file-loader.js';
import { TextDocumentParser } from './documents/parser.js';
import { HuggingFaceModelRepository } from './models/huggingface-artifacts.js';
import { loadTransformersTokenizer } from './tokenization/transformers-tokenizer.js';
import { loadTransformersModel } from './embeddings/transformers-model.js';
import { TransformersEmbeddingProvider } from './embeddings/transformers-embedder.js';
import { TokenDocumentChunker } from './chunking/token-chunker.js';
import { EmbeddingGemmaFormatter } from './embeddings/formatter.js';
import { createOllamaClient, requireModel } from './ollama/client.js';
import { SqliteVectorStore } from './storage/sqlite-store.js';
import { VectorRetriever } from './retrieval/vector-retriever.js';
import { SourcesContextBuilder } from './generation/context-builder.js';
import { OllamaAnswerGenerator } from './generation/ollama-generator.js';
import { RagService } from './core/rag-service.js';
import type { RagStages } from './core/rag-service.js';
import { hash } from './core/hash.js';

async function createEmbeddingComponents(
  config: RuntimeConfig,
  repository: ModelArtifactRepository = new HuggingFaceModelRepository(config.artifacts),
) {
  const artifacts = await repository.load();
  const tokenizer = await loadTransformersTokenizer(artifacts);
  const runner = await loadTransformersModel(artifacts, config.model);
  try {
    const formatter = new EmbeddingGemmaFormatter(config.embedding);
    const embedder = new TransformersEmbeddingProvider(
      runner,
      config.embedding,
      {
        model: config.artifacts.repository,
        digest: hash(artifacts.fingerprint + runner.signature),
        dimensions: config.embedding.dimensions,
      },
      tokenizer.signature,
    );
    return { artifacts, tokenizer, formatter, embedder, runner };
  } catch (error) {
    await runner.close();
    throw error;
  }
}

/** The single place where stage implementations are selected and connected. */
export async function createApplication(config: RuntimeConfig, createStore = true) {
  const { artifacts, tokenizer, formatter, embedder, runner } =
    await createEmbeddingComponents(config);
  let store: SqliteVectorStore | undefined;
  try {
    const model = await embedder.describe();
    const signature = JSON.stringify({
      model,
      backend: runner.signature,
      tokenizer: tokenizer.signature,
      formatting: formatter.signature,
      maxTokens: config.embedding.maxTokens,
    });
    store = new SqliteVectorStore(config.storage.path, {
      dimensions: model.dimensions,
      signature,
      create: createStore,
      readOnly: !createStore,
    });
    // Constructing a client makes no network request; only answer generation uses Ollama.
    const client = createOllamaClient(config.ollama);
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
      retriever: new VectorRetriever(formatter, tokenizer, embedder, store, config.app.retrieval),
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
      artifacts,
    };
  } catch (error) {
    try {
      store?.close();
    } finally {
      await embedder.close();
    }
    throw error;
  }
}

export async function setupApplication(config: RuntimeConfig) {
  const repository: ModelArtifactRepository = new HuggingFaceModelRepository(config.artifacts);
  const artifacts = await repository.prepare();
  return {
    modelDirectory: artifacts.directory,
    repository: config.artifacts.repository,
    revision: config.artifacts.revision,
    dtype: config.model.dtype,
    bytes: config.artifacts.assets.reduce((total, asset) => total + asset.bytes, 0),
    files: config.artifacts.assets.length,
  };
}

export type CheckMode = 'all' | 'storage' | 'embedding';

export async function checkApplication(config: RuntimeConfig, mode: CheckMode = 'all') {
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
  if (mode === 'storage') return { storage };
  const { tokenizer, formatter, embedder } = await createEmbeddingComponents(config);
  try {
    const input = tokenizer.encode(formatter.query('Local embedding check'));
    const result = await embedder.embed([input]);
    const embedding = {
      model: await embedder.describe(),
      inputTokens: input.tokenIds.length,
      vectorDimensions: result.vectors[0]?.length,
      device: config.model.device,
      dtype: config.model.dtype,
    };
    if (mode === 'embedding') return { storage, embedding };
    const client = createOllamaClient(config.ollama);
    await requireModel(client, config.llm.model);
    return { storage, embedding, llmModel: config.llm.model };
  } finally {
    await embedder.close();
  }
}
