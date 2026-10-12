import type { Ollama } from 'ollama';
import type { AnswerContext, AnswerGenerator } from '../core/contracts.js';

export interface OllamaGenerationOptions {
  model: string;
  contextTokens: number;
  maxOutputTokens: number;
  temperature: number;
  think: boolean;
}

export class OllamaAnswerGenerator implements AnswerGenerator {
  constructor(
    private readonly client: Ollama,
    private readonly config: OllamaGenerationOptions,
    private readonly keepAlive: string,
  ) {}
  async generate(context: AnswerContext): Promise<string> {
    const response = await this.client.chat({
      model: this.config.model,
      messages: context.messages,
      stream: false,
      think: this.config.think,
      keep_alive: this.keepAlive,
      options: {
        temperature: this.config.temperature,
        num_ctx: this.config.contextTokens,
        num_predict: this.config.maxOutputTokens,
      },
    });
    if (response.done_reason === 'length')
      throw new Error(
        'The LLM answer was truncated by the token limit. Increase LLM_MAX_OUTPUT_TOKENS or LLM_CONTEXT_TOKENS.',
      );
    const answer = response.message.content.trim();
    if (!answer) throw new Error('Ollama returned an empty answer.');
    const allowed = new Set(context.sources.map((source) => source.id));
    for (const match of answer.matchAll(/\[(\d+)\]/gu)) {
      if (!allowed.has(Number(match[1])))
        throw new Error('The LLM cited a source that is missing from the supplied context.');
    }
    return answer;
  }
}
