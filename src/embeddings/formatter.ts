import type { EmbeddingFormatter } from '../core/contracts.js';

export interface EmbeddingFormatOptions {
  queryPrefix: string;
  documentTemplate: string;
}

/** Input formatting is specific to the embedding model and independent of parsing or storage. */
export class EmbeddingGemmaFormatter implements EmbeddingFormatter {
  constructor(private readonly config: EmbeddingFormatOptions) {}

  get signature(): string {
    return JSON.stringify({
      implementation: 'embeddinggemma-v1',
      queryPrefix: this.config.queryPrefix,
      documentTemplate: this.config.documentTemplate,
    });
  }
  document(name: string, section: string, body: string): string {
    return this.config.documentTemplate.replace(/\{(title|text)\}/gu, (_match, key: string) =>
      key === 'title' ? `${name} — ${section}` : body,
    );
  }
  query(question: string): string {
    return this.config.queryPrefix + question;
  }
}
