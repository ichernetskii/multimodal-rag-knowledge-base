import type { Ollama } from 'ollama';
import type {
  EmbeddingBatch,
  EmbeddingModelInfo,
  EmbeddingProvider,
  TokenCounter,
} from '../core/contracts.js';
import { requireModel } from '../ollama/client.js';
import type { OllamaConnectionOptions } from '../ollama/client.js';

export interface OllamaEmbeddingOptions {
  model: string;
  dimensions: number;
  maxTokens: number;
  tokenSafetyMargin: number;
  expectedFamily: string;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private snapshot?: EmbeddingModelInfo;
  constructor(
    private readonly client: Ollama,
    private readonly config: OllamaEmbeddingOptions,
    private readonly ollamaConfig: OllamaConnectionOptions,
    private readonly tokenizer: TokenCounter,
  ) {}
  async describe(): Promise<EmbeddingModelInfo> {
    const model = await requireModel(this.client, this.config.model);
    if (this.snapshot) {
      if (model.digest !== this.snapshot.digest)
        throw new Error(
          'The embedding model changed during the command. Retry with a compatible index.',
        );
      return this.snapshot;
    }
    const metadata = await this.client.show({ model: this.config.model });
    if (
      !metadata.capabilities.includes('embedding') ||
      metadata.details.family !== this.config.expectedFamily
    ) {
      throw new Error(
        'The Ollama model is incompatible with the selected embedding profile. Align the model, input format, and tokenizer.',
      );
    }
    this.snapshot = { model: model.name, digest: model.digest, dimensions: this.config.dimensions };
    return this.snapshot;
  }
  async embed(inputs: readonly string[]): Promise<EmbeddingBatch> {
    if (!inputs.length) return { vectors: [], inputTokens: 0 };
    let expectedTokens = 0;
    for (const input of inputs) {
      const tokens = this.tokenizer.count(input);
      expectedTokens += tokens;
      if (tokens > this.config.maxTokens - this.config.tokenSafetyMargin)
        throw new Error(`Embedding model input: ${tokens} tokens. Shorten the question or chunk.`);
    }
    await this.describe();
    const response = await this.client.embed({
      model: this.config.model,
      input: [...inputs],
      truncate: false,
      dimensions: this.config.dimensions,
      keep_alive: this.ollamaConfig.keepAlive,
      options: { num_ctx: this.config.maxTokens },
    });
    await this.describe();
    if (
      !Array.isArray(response.embeddings) ||
      response.embeddings.length !== inputs.length ||
      response.embeddings.some(
        (vector) =>
          !Array.isArray(vector) ||
          vector.length !== this.config.dimensions ||
          vector.some((value) => !Number.isFinite(value)) ||
          Math.hypot(...vector) === 0,
      )
    ) {
      throw new Error('Ollama returned invalid embedding vectors. Check the model and dimensions.');
    }
    if (response.prompt_eval_count !== expectedTokens)
      throw new Error(
        `The tokenizer does not match Ollama: local ${expectedTokens}, Ollama ${response.prompt_eval_count}. Check the embedding profile.`,
      );
    return { vectors: response.embeddings, inputTokens: response.prompt_eval_count };
  }
}
