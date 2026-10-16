import type { AIProvider, Modality, ModelProfile } from '../../shared/api/contracts.generated';
export const providerNames: Record<AIProvider, string> = {
  google: 'Google Gemini',
  anthropic: 'Anthropic Claude',
  ollama: 'Ollama',
  'openai-compatible': 'Сервер с OpenAI API',
  whisper: 'Whisper',
  test: 'TEST AI · проверка разработки',
};
export const taskNames = {
  generation: 'Ответы и понимание материалов',
  embedding: 'Поиск по базе знаний',
  transcription: 'Распознавание записей',
} as const;
export const modalityNames = {
  text: 'Текст',
  image: 'Изображения',
  audio: 'Аудио',
  video: 'Видео',
  pdf: 'PDF',
} as const;
export const numeric = {
  dimensions: 'Размерность поискового вектора',
  contextTokens: 'Контекст, токенов',
  maxOutputTokens: 'Максимальный ответ, токенов',
  maxBytes: 'Лимит медиа, байт',
  maxSeconds: 'Лимит фрагмента, секунд',
  concurrency: 'Одновременных вызовов',
  requestsPerMinute: 'Запросов в минуту',
  tokensPerMinute: 'Токенов в минуту',
  timeoutMs: 'Таймаут, мс',
} as const;
export function providerRoles(provider: AIProvider): ModelProfile['role'][] {
  return provider === 'whisper'
    ? ['transcription']
    : provider === 'anthropic'
      ? ['generation']
      : provider === 'google'
        ? ['generation', 'embedding', 'transcription']
        : ['generation', 'embedding'];
}
export function providerInputs(provider: AIProvider, role: ModelProfile['role']): Modality[] {
  if (provider === 'whisper') return ['audio'];
  if (role === 'transcription') return ['text', 'audio'];
  if (provider === 'anthropic') return ['text', 'image', 'pdf'];
  if (provider === 'ollama' || provider === 'openai-compatible')
    return role === 'embedding' ? ['text'] : ['text', 'image'];
  return ['text', 'image', 'audio', 'video', 'pdf'];
}
export function isOwnServer(provider: AIProvider) {
  return provider === 'ollama' || provider === 'whisper';
}
export function needsCredential(provider: AIProvider) {
  return ['google', 'anthropic', 'openai-compatible'].includes(provider);
}
export function createProfile(
  provider: AIProvider = 'google',
  role: ModelProfile['role'] = providerRoles(provider)[0]!,
): ModelProfile {
  const embedding = role === 'embedding';
  const model =
    provider === 'whisper'
      ? 'small'
      : provider === 'ollama'
        ? embedding
          ? 'embeddinggemma'
          : 'qwen3.5:4b'
        : provider === 'anthropic'
          ? 'claude-sonnet-4-6'
          : provider === 'google'
            ? embedding
              ? 'gemini-embedding-2'
              : 'gemini-3.8-flash'
            : '';
  return {
    id: crypto.randomUUID(),
    revision: 0,
    name: providerNames[provider],
    provider,
    role,
    model,
    endpoint:
      provider === 'google'
        ? 'https://generativelanguage.googleapis.com'
        : provider === 'anthropic'
          ? 'https://api.anthropic.com'
          : provider === 'ollama'
            ? 'http://127.0.0.1:11434'
            : '',
    secretRef: '',
    input: providerInputs(provider, role),
    dimensions: embedding ? (provider === 'ollama' ? 768 : 1536) : 0,
    contextTokens: embedding ? 2048 : 16000,
    maxOutputTokens: embedding ? 0 : role === 'transcription' ? 2048 : 1024,
    maxBytes: 20 * 1024 * 1024,
    maxSeconds: 60,
    concurrency: 1,
    requestsPerMinute: 60,
    tokensPerMinute: 100000,
    inputMicrosPerMillion: { text: 0, image: 0, audio: 0, video: 0 },
    outputMicrosPerMillion: 0,
    timeoutMs: 300000,
    cache: role === 'generation',
    enabled: false,
  };
}
