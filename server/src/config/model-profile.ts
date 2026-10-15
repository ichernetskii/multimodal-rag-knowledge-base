/** Pinned q8 ONNX export: config, tokenizer, graph, and external weights form one bundle. */
export const embeddingGemmaProfile = {
  repository: 'onnx-community/embeddinggemma-300m-ONNX',
  revision: '5090578d9565bb06545b4552f76e6bc2c93e4a66',
  dtype: 'q8' as const,
  modelType: 'gemma3_text',
  dimensions: 768,
  supportedDimensions: [128, 256, 512, 768] as readonly number[],
  maxTokens: 2048,
  tokenSafetyMargin: 8,
  vocabularySize: 262144,
  padTokenId: 0,
  inputFormat: {
    queryPrefix: 'task: search result | query: ',
    documentTemplate: 'title: {title} | text: {text}',
  },
  assets: [
    {
      name: 'config.json',
      bytes: 1765,
      sha256: '6e1f06404b7163e0325ed2ea3e6781cde50f4a50b31780a95ad0d30e8404d77b',
    },
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
    {
      name: 'onnx/model_quantized.onnx',
      bytes: 567874,
      sha256: '172efde319fe1542dc41f31be6154910b05b78f7a861c265c4600eec906bd6d8',
    },
    {
      name: 'onnx/model_quantized.onnx_data',
      bytes: 308890624,
      sha256: '705626e28e4c23c82ade34566b4197d97f534c12275fa406dfb71e9937d388c0',
    },
  ],
} as const;
