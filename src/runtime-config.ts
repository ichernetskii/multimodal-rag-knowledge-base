import { resolve } from 'node:path';
import { integer, loadConfig } from './config.js';
import type { AppConfig, Environment } from './config.js';
import { embeddingGemmaProfile } from './model-profiles/embeddinggemma.js';
import type { OllamaConnectionOptions } from './ollama/client.js';
import type { TransformersEmbeddingOptions } from './embeddings/transformers-embedder.js';
import type { TransformersModelOptions } from './embeddings/transformers-model.js';
import type { HuggingFaceArtifactOptions } from './models/huggingface-artifacts.js';
import type { EmbeddingFormatOptions } from './embeddings/formatter.js';
import type { OllamaGenerationOptions } from './generation/ollama-generator.js';

/** Configuration for the selected adapters, used by application assembly and kept outside the RAG core. */
export interface RuntimeConfig {
  app: AppConfig;
  ollama: OllamaConnectionOptions;
  embedding: TransformersEmbeddingOptions & EmbeddingFormatOptions;
  model: TransformersModelOptions;
  artifacts: HuggingFaceArtifactOptions;
  storage: { path: string };
  llm: OllamaGenerationOptions;
}

export function loadRuntimeConfig(env: Environment = process.env): RuntimeConfig {
  const app = loadConfig(env);
  const profile = embeddingGemmaProfile;
  const url = env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
  if (!['http:', 'https:'].includes(new URL(url).protocol))
    throw new Error('OLLAMA_URL must start with http:// or https://.');
  const maxTokens = integer(env, 'EMBEDDING_MAX_TOKENS', profile.maxTokens, 32, profile.maxTokens);
  if (app.chunking.targetTokens > maxTokens - profile.tokenSafetyMargin)
    throw new Error('CHUNK_TOKENS exceeds the available embedding model input budget.');
  const dimensions = integer(
    env,
    'EMBEDDING_DIMENSIONS',
    profile.dimensions,
    1,
    profile.dimensions,
  );
  if (!profile.supportedDimensions.includes(dimensions))
    throw new Error('EMBEDDING_DIMENSIONS: expected 128, 256, 512, or 768.');
  return {
    app,
    ollama: {
      url,
      timeoutMs: integer(env, 'OLLAMA_TIMEOUT_MS', 300_000, 1000, 1_800_000),
      keepAlive: env.OLLAMA_KEEP_ALIVE ?? '5m',
    },
    embedding: {
      dimensions,
      modelDimensions: profile.dimensions,
      vocabularySize: profile.vocabularySize,
      maxTokens,
      tokenSafetyMargin: profile.tokenSafetyMargin,
      ...profile.inputFormat,
    },
    model: {
      dtype: profile.dtype,
      device: 'cpu',
      threads: integer(env, 'EMBEDDING_THREADS', 4, 1, 64),
      padTokenId: profile.padTokenId,
      modelType: profile.modelType,
      dimensions: profile.dimensions,
    },
    artifacts: {
      repository: profile.repository,
      revision: profile.revision,
      assets: profile.assets,
      directory: resolve(
        env.EMBEDDING_CACHE ?? '.cache/models',
        profile.repository.replaceAll('/', '--'),
        profile.revision,
      ),
      downloadTimeoutMs: integer(env, 'MODEL_DOWNLOAD_TIMEOUT_MS', 600_000, 1000, 1_800_000),
    },
    storage: { path: resolve(env.SQLITE_PATH ?? 'data/rag.sqlite') },
    llm: {
      model: env.OLLAMA_MODEL ?? 'qwen3.5:4b',
      contextTokens: integer(env, 'LLM_CONTEXT_TOKENS', 8192, 512, 131072),
      maxOutputTokens: integer(env, 'LLM_MAX_OUTPUT_TOKENS', 512, 16, 8192),
      temperature: 0,
      think: false,
    },
  };
}
