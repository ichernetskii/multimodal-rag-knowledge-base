import { resolve } from 'node:path';
import { integer, loadConfig } from './config.js';
import type { AppConfig, Environment } from './config.js';
import { embeddingGemmaProfile } from './model-profiles/embeddinggemma.js';
import type { OllamaConnectionOptions } from './ollama/client.js';
import type { OllamaEmbeddingOptions } from './embeddings/ollama-embedder.js';
import type { EmbeddingFormatOptions } from './embeddings/formatter.js';
import type { OllamaGenerationOptions } from './generation/ollama-generator.js';
import type { TokenizerFilesOptions } from './tokenization/huggingface-tokenizer.js';

/** Configuration for the selected adapters, used by application assembly and kept outside the RAG core. */
export interface RuntimeConfig {
  app: AppConfig;
  ollama: OllamaConnectionOptions;
  embedding: OllamaEmbeddingOptions & EmbeddingFormatOptions;
  tokenizer: TokenizerFilesOptions;
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
  return {
    app,
    ollama: {
      url,
      timeoutMs: integer(env, 'OLLAMA_TIMEOUT_MS', 300_000, 1000, 1_800_000),
      keepAlive: env.OLLAMA_KEEP_ALIVE ?? '5m',
    },
    embedding: {
      model: env.OLLAMA_EMBEDDING_MODEL ?? profile.model,
      expectedFamily: profile.family,
      dimensions: integer(env, 'EMBEDDING_DIMENSIONS', profile.dimensions, 1, profile.dimensions),
      maxTokens,
      tokenSafetyMargin: profile.tokenSafetyMargin,
      ...profile.inputFormat,
    },
    tokenizer: {
      ...profile.tokenizer,
      directory: resolve(
        env.TOKENIZER_CACHE ?? '.cache/tokenizers',
        profile.tokenizer.repository.replaceAll('/', '--'),
        profile.tokenizer.revision,
      ),
      downloadTimeoutMs: 120_000,
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
