/** Model-specific profile. The revision identifies a source commit; it is unrelated to ONNX Runtime. */
export const embeddingGemmaProfile = {
  model: 'embeddinggemma',
  family: 'gemma3',
  dimensions: 768,
  maxTokens: 2048,
  tokenSafetyMargin: 8,
  inputFormat: {
    queryPrefix: 'task: search result | query: ',
    documentTemplate: 'title: {title} | text: {text}',
  },
  tokenizer: {
    // Only the two tokenizer JSON files are used from the public export; ONNX weights are not downloaded.
    repository: 'onnx-community/embeddinggemma-300m-ONNX',
    revision: '5090578d9565bb06545b4552f76e6bc2c93e4a66',
    assets: [
      {
        name: 'tokenizer.json',
        bytes: 20323312,
        sha256: '4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47',
      },
      {
        name: 'tokenizer_config.json',
        bytes: 1156830,
        sha256: '3ca953eea6c3c9fcda9cf3df22949ff18b216f7c74bd6459230f3f1013953f3a',
      },
    ],
  },
} as const;
