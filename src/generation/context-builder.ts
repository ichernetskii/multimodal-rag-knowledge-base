import type { AppConfig } from '../config.js';
import type {
  AnswerContext,
  ContextBuilder,
  SearchHit,
  SourceReference,
} from '../core/contracts.js';

export class SourcesContextBuilder implements ContextBuilder {
  constructor(private readonly config: AppConfig['context']) {}
  build(question: string, hits: readonly SearchHit[]): AnswerContext {
    const sources: SourceReference[] = [];
    const userContent = (items: SourceReference[]) =>
      `Question: ${question}\n\nRetrieved sources:\n${JSON.stringify(items)}`;
    if (this.config.systemPrompt.length + userContent([]).length > this.config.maxCharacters)
      throw new Error(
        'The question and instruction do not fit in the context. Shorten the question or increase CONTEXT_MAX_CHARACTERS.',
      );
    for (const hit of hits) {
      const source = {
        id: sources.length + 1,
        documentId: hit.document.id,
        name: hit.document.name,
        section: hit.chunk.section,
        text: hit.chunk.body,
      };
      if (
        this.config.systemPrompt.length + userContent([...sources, source]).length >
        this.config.maxCharacters
      )
        continue;
      sources.push(source);
    }
    if (!sources.length)
      throw new Error(
        'Retrieved chunks do not fit in the context. Reduce CHUNK_TOKENS or increase CONTEXT_MAX_CHARACTERS.',
      );
    return {
      sources,
      messages: [
        { role: 'system', content: this.config.systemPrompt },
        { role: 'user', content: userContent(sources) },
      ],
    };
  }
}
