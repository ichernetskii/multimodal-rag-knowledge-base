import type {
  EmbeddingBatch,
  EmbeddingModelInfo,
  EmbeddingProvider,
  TokenEmbeddingModel,
  TokenizedInput,
} from '../core/contracts.js';

export interface TransformersEmbeddingOptions {
  dimensions: number;
  modelDimensions: number;
  maxTokens: number;
  tokenSafetyMargin: number;
  vocabularySize: number;
}

/** Validates prepared inputs and outputs independently of tensor SDKs and tokenization. */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  private closed = false;
  constructor(
    private readonly runner: TokenEmbeddingModel,
    private readonly options: TransformersEmbeddingOptions,
    private readonly model: EmbeddingModelInfo,
    private readonly tokenizerSignature: string,
  ) {
    if (
      !Number.isInteger(options.dimensions) ||
      options.dimensions < 1 ||
      !Number.isInteger(options.modelDimensions) ||
      options.dimensions > options.modelDimensions ||
      model.dimensions !== options.dimensions
    )
      throw new Error('Invalid embedding dimensions.');
  }

  async describe(): Promise<EmbeddingModelInfo> {
    if (this.closed) throw new Error('The embedding provider is closed.');
    return { ...this.model };
  }

  async embed(inputs: readonly TokenizedInput[]): Promise<EmbeddingBatch> {
    if (this.closed) throw new Error('The embedding provider is closed.');
    if (!inputs.length) return { vectors: [], inputTokens: 0 };
    let inputTokens = 0;
    for (const input of inputs) {
      if (input.tokenizerSignature !== this.tokenizerSignature)
        throw new Error('Prepared tokens belong to a different tokenizer or model bundle.');
      const ids = input.tokenIds;
      if (
        !ids.length ||
        ids.some((id) => !Number.isSafeInteger(id) || id < 0 || id >= this.options.vocabularySize)
      )
        throw new Error('Invalid embedding token IDs.');
      if (ids.length > this.options.maxTokens - this.options.tokenSafetyMargin)
        throw new Error('Embedding input exceeds the token budget. Shorten the question or chunk.');
      inputTokens += ids.length;
    }
    // Preserve the exact arrays returned by the tokenizer: no text, decode, or re-encode step.
    const raw = await this.runner.embed(inputs.map((input) => input.tokenIds));
    if (raw.length !== inputs.length)
      throw new Error('The model returned an invalid number of embedding vectors.');
    const vectors = raw.map((vector) => {
      if (vector.length !== this.options.modelDimensions || !vector.every(Number.isFinite))
        throw new Error('The model returned an invalid embedding vector.');
      // Matryoshka dimensions: truncate the sentence embedding and normalize again.
      const values = vector.slice(0, this.options.dimensions);
      const norm = Math.hypot(...values);
      if (norm === 0 || !Number.isFinite(norm))
        throw new Error('The model returned a zero or invalid embedding vector.');
      return values.map((value) => value / norm);
    });
    return { vectors, inputTokens };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.runner.close();
  }
}
