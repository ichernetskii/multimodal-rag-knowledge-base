import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelArtifactRepository } from '../../application/ports/embedding.js';
import type { RuntimeConfig } from '../../config/runtime-config.js';
import { hash } from '../../shared/hash.js';
import { Catalog } from '../database/catalog.js';
import { schemaVersion } from '../database/schema.js';
import { EmbeddingGemmaFormatter } from './embedding-formatter.js';
import { TransformersEmbeddingProvider } from './embedding-provider.js';
import { HuggingFaceModelRepository } from './model-artifacts.js';
import { loadTransformersModel } from './onnx-model.js';
import { loadTransformersTokenizer } from './tokenizer.js';
export async function createEmbeddingComponents(
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
type CheckMode = 'all' | 'storage' | 'embedding';
export async function checkApplication(config: RuntimeConfig, mode: CheckMode = 'all') {
  const directory = mkdtempSync(join(tmpdir(), 'rag-diagnostic-')),
    catalog = new Catalog(directory);
  let storage;
  try {
    storage = {
      schema: schemaVersion,
      integrity: catalog.prepare('PRAGMA integrity_check').get()?.integrity_check,
    };
  } finally {
    catalog.close();
    rmSync(directory, { recursive: true, force: true });
  }
  if (mode === 'storage') return { storage };
  const { tokenizer, formatter, embedder } = await createEmbeddingComponents(config);
  try {
    const input = tokenizer.encode(formatter.query('Local embedding check')),
      result = await embedder.embed([input]);
    const embedding = {
      model: await embedder.describe(),
      inputTokens: input.tokenIds.length,
      vectorDimensions: result.vectors[0]?.length,
      device: config.model.device,
      dtype: config.model.dtype,
    };
    if (mode === 'embedding') return { storage, embedding };
    const response = await fetch(new URL('/api/tags', config.ollama.url), {
      signal: AbortSignal.timeout(config.ollama.timeoutMs),
    });
    if (!response.ok) throw new Error('Модель генерации недоступна.');
    const tags = (await response.json()) as { models?: { name: string }[] };
    if (!tags.models?.some((model) => model.name === config.llm.model))
      throw new Error('Подготовьте локальную модель генерации: ' + config.llm.model);
    return { storage, embedding, llmModel: config.llm.model };
  } finally {
    await embedder.close();
  }
}
