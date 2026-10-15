import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ModelArtifacts,
  TokenEmbeddingModel,
  Vector,
} from '../../application/ports/embedding.js';

export interface TransformersModelOptions {
  dtype: 'q8';
  device: 'cpu';
  threads: number;
  padTokenId: number;
  modelType: string;
  dimensions: number;
}
interface PaddedTokenBatch {
  inputIds: BigInt64Array;
  attentionMask: BigInt64Array;
  shape: [number, number];
}

/** Right-padding changes neither the prepared sequence nor the count of its real tokens. */
export function padTokenBatch(
  inputs: readonly (readonly number[])[],
  padTokenId: number,
): PaddedTokenBatch {
  if (!inputs.length || inputs.some((input) => !input.length))
    throw new Error('Cannot construct an empty token batch.');
  const width = Math.max(...inputs.map((input) => input.length));
  const inputIds = new BigInt64Array(inputs.length * width).fill(BigInt(padTokenId));
  const attentionMask = new BigInt64Array(inputIds.length);
  inputs.forEach((input, row) => {
    input.forEach((id, column) => {
      const index = row * width + column;
      inputIds[index] = BigInt(id);
      attentionMask[index] = 1n;
    });
  });
  return { inputIds, attentionMask, shape: [inputs.length, width] };
}

export async function loadTransformersModel(
  artifacts: ModelArtifacts,
  options: TransformersModelOptions,
): Promise<TokenEmbeddingModel> {
  const config: unknown = JSON.parse(
    await readFile(join(artifacts.directory, 'config.json'), 'utf8'),
  );
  if (
    !config ||
    typeof config !== 'object' ||
    !('model_type' in config) ||
    config.model_type !== options.modelType ||
    !('hidden_size' in config) ||
    config.hidden_size !== options.dimensions
  )
    throw new Error('The model configuration is incompatible with the embedding profile.');
  const { AutoModel, Tensor, env } = await import('@huggingface/transformers');
  const model = await AutoModel.from_pretrained(artifacts.directory, {
    local_files_only: true,
    dtype: options.dtype,
    device: options.device,
    session_options: { intraOpNumThreads: options.threads, interOpNumThreads: 1 },
  });
  let closed = false;
  return {
    signature: JSON.stringify({
      implementation: 'transformers-onnx-v1',
      version: env.version,
      dtype: options.dtype,
      device: options.device,
      dimensions: options.dimensions,
    }),
    async embed(inputs): Promise<Vector[]> {
      if (closed) throw new Error('The ONNX model is closed.');
      if (!inputs.length) return [];
      const batch = padTokenBatch(inputs, options.padTokenId);
      const inputIds = new Tensor('int64', batch.inputIds, batch.shape);
      const mask = new Tensor('int64', batch.attentionMask, batch.shape);
      let outputs: unknown;
      try {
        outputs = await model.forward({ input_ids: inputIds, attention_mask: mask });
        if (!outputs || typeof outputs !== 'object' || !('sentence_embedding' in outputs))
          throw new Error('The ONNX model did not return sentence_embedding.');
        const embedding = outputs.sentence_embedding;
        if (
          !(embedding instanceof Tensor) ||
          embedding.dims.length !== 2 ||
          embedding.dims[0] !== inputs.length ||
          embedding.dims[1] !== options.dimensions ||
          !(embedding.data instanceof Float32Array)
        )
          throw new Error('The ONNX model returned an invalid sentence_embedding tensor.');
        const data = embedding.data;
        return inputs.map((_input, row) =>
          Array.from(data.subarray(row * options.dimensions, (row + 1) * options.dimensions)),
        );
      } finally {
        inputIds.dispose();
        mask.dispose();
        if (outputs && typeof outputs === 'object') {
          for (const value of Object.values(outputs)) {
            if (value instanceof Tensor) value.dispose();
          }
        }
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await model.dispose();
    },
  };
}
