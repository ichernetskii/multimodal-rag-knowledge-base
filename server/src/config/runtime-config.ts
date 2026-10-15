import { serverPath } from './paths.js';
import { AppError } from '../shared/errors.js';
interface OllamaConnectionOptions {
  url: string;
  timeoutMs: number;
  keepAlive: string;
}
interface OllamaGenerationOptions {
  model: string;
  contextTokens: number;
  maxOutputTokens: number;
  temperature: number;
  think: boolean;
}
import { resolve } from 'node:path';
import type { EmbeddingFormatOptions } from '../infrastructure/models/embedding-formatter.js';
import type { TransformersEmbeddingOptions } from '../infrastructure/models/embedding-provider.js';
import type { HuggingFaceArtifactOptions } from '../infrastructure/models/model-artifacts.js';
import type { TransformersModelOptions } from '../infrastructure/models/onnx-model.js';
import type { AppConfig, Environment } from './app-config.js';
import { integer, loadConfig } from './app-config.js';
import { embeddingGemmaProfile } from './model-profile.js';

/** Configuration for the selected adapters, used by application assembly and kept outside the RAG core. */
export interface RuntimeConfig {
  app: AppConfig;
  ollama: OllamaConnectionOptions;
  embedding: TransformersEmbeddingOptions & EmbeddingFormatOptions;
  model: TransformersModelOptions;
  artifacts: HuggingFaceArtifactOptions;
  llm: OllamaGenerationOptions;
}

export function loadRuntimeConfig(env: Environment = process.env): RuntimeConfig {
  const app = loadConfig(env);
  const profile = embeddingGemmaProfile;
  const url = env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
  let origin: URL;
  try {
    origin = new URL(url);
  } catch {
    throw new AppError('INVALID_CONFIG', 'OLLAMA_URL: укажите HTTP(S) origin модели.');
  }
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new AppError(
      'INVALID_CONFIG',
      'OLLAMA_URL: укажите HTTP(S) origin без пути, пароля и параметров.',
    );
  const maxTokens = integer(env, 'EMBEDDING_MAX_TOKENS', profile.maxTokens, 32, profile.maxTokens);
  if (app.chunking.targetTokens > maxTokens - profile.tokenSafetyMargin)
    throw new AppError(
      'INVALID_CONFIG',
      'CHUNK_TOKENS exceeds the available embedding model input budget.',
    );
  const dimensions = integer(
    env,
    'EMBEDDING_DIMENSIONS',
    profile.dimensions,
    1,
    profile.dimensions,
  );
  if (!profile.supportedDimensions.includes(dimensions))
    throw new AppError('INVALID_CONFIG', 'EMBEDDING_DIMENSIONS: expected 128, 256, 512, or 768.');
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
        serverPath(env.EMBEDDING_CACHE ?? '.cache/models'),
        profile.repository.replaceAll('/', '--'),
        profile.revision,
      ),
      downloadTimeoutMs: integer(env, 'MODEL_DOWNLOAD_TIMEOUT_MS', 600_000, 1000, 1_800_000),
    },
    llm: {
      model: env.OLLAMA_MODEL ?? 'qwen3.5:4b',
      contextTokens: integer(env, 'LLM_CONTEXT_TOKENS', 8192, 512, 131072),
      maxOutputTokens: integer(env, 'LLM_MAX_OUTPUT_TOKENS', 512, 16, 8192),
      temperature: 0,
      think: false,
    },
  };
}

/** Machine-specific paths, endpoints and CPU capacity belong to the current deployment. */
export function bindDeployment(saved: RuntimeConfig, current: RuntimeConfig): RuntimeConfig {
  return {
    ...saved,
    artifacts: {
      ...saved.artifacts,
      directory: current.artifacts.directory,
      downloadTimeoutMs: current.artifacts.downloadTimeoutMs,
    },
    ollama: { ...saved.ollama, url: current.ollama.url },
    model: { ...saved.model, threads: current.model.threads },
  };
}
