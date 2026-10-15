import type {
  ModelArtifacts,
  TextTokenizer,
  TokenizedInput,
} from '../../application/ports/embedding.js';

interface TokenEncoder {
  encode(text: string, options: { add_special_tokens: boolean }): number[];
}

/** Token IDs are immutable and carry the identity of the tokenizer that prepared them. */
export class TransformersTextTokenizer implements TextTokenizer {
  constructor(
    private readonly encoder: TokenEncoder,
    readonly signature: string,
  ) {}

  encode(text: string, options?: { includeSpecialTokens?: boolean }): TokenizedInput {
    const tokenIds = Object.freeze(
      this.encoder.encode(text, {
        add_special_tokens: options?.includeSpecialTokens ?? true,
      }),
    );
    return Object.freeze({ tokenIds, tokenizerSignature: this.signature });
  }
}

export async function loadTransformersTokenizer(artifacts: ModelArtifacts): Promise<TextTokenizer> {
  const { AutoTokenizer } = await import('@huggingface/transformers');
  const encoder = await AutoTokenizer.from_pretrained(artifacts.directory, {
    local_files_only: true,
  });
  return new TransformersTextTokenizer(
    encoder,
    'transformers-tokenizer-v1:' + artifacts.fingerprint,
  );
}
