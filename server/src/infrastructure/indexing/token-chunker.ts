import type {
  DocumentChunker,
  DocumentSection,
  EmbeddingFormatter,
  LoadedDocument,
  PreparedDocumentChunk,
  TextTokenizer,
  TokenizedInput,
} from '../../application/ports/embedding.js';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { requireValue } from '../../shared/errors.js';

/** Count the complete model input instead of adding individual word token counts. */
export class TokenDocumentChunker implements DocumentChunker {
  constructor(
    private readonly tokenizer: TextTokenizer,
    private readonly formatter: EmbeddingFormatter,
    private readonly config: { targetTokens: number; overlapTokens: number; maxCharacters: number },
    private readonly maxInputTokens: number,
  ) {}

  async chunk(
    document: LoadedDocument,
    sections: readonly DocumentSection[],
    options: { signal?: AbortSignal; maxChunks?: number } = {},
  ): Promise<PreparedDocumentChunk[]> {
    const chunks: PreparedDocumentChunk[] = [];
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const section of sections) {
      if (
        this.tokenizer.encode(this.formatter.document(document.name, section.title, '')).tokenIds
          .length +
          8 >
        this.config.targetTokens
      ) {
        throw new Error(`The section title is too long: ${section.title}.`);
      }
      const positions = [0];
      for (const item of segmenter.segment(section.text)) {
        positions.push(item.index + item.segment.length);
        if (positions.length % 8192 === 0) {
          options.signal?.throwIfAborted();
          await yieldToIO();
        }
      }
      const end = positions.length - 1;
      const offset = (index: number) => {
        const value = positions[index];
        if (value === undefined) throw new Error('Invalid chunk boundary.');
        return value;
      };
      const body = (start: number, stop: number) => section.text.slice(offset(start), offset(stop));
      let start = 0;
      while (start < end) {
        options.signal?.throwIfAborted();
        if (chunks.length % 4 === 0) await yieldToIO();
        const prepared = new Map<number, TokenizedInput>();
        const encode = (stop: number) => {
          let tokens = prepared.get(stop);
          if (tokens === undefined) {
            tokens = this.tokenizer.encode(
              this.formatter.document(document.name, section.title, body(start, stop)),
            );
            prepared.set(stop, tokens);
          }
          return tokens;
        };
        const fits = (stop: number) => {
          const tokens = encode(stop);
          return (
            tokens.tokenIds.length <= Math.min(this.config.targetTokens, this.maxInputTokens) &&
            offset(stop) - offset(start) <= this.config.maxCharacters
          );
        };
        // Use exponential search to bound tokenization work, then refine the boundary.
        let best = start;
        let upper = Math.min(end, start + this.config.targetTokens);
        while (fits(upper)) {
          best = upper;
          if (upper === end) break;
          upper = Math.min(end, start + (upper - start) * 2);
        }
        let low = best + 1;
        let high = upper - 1;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (fits(middle)) {
            best = middle;
            low = middle + 1;
          } else high = middle - 1;
        }
        if (best === start)
          throw new Error(
            'A single grapheme with the title does not fit in the chunk budget. Increase CHUNK_TOKENS.',
          );
        // Prefer paragraph, line, or whitespace boundaries when the resulting chunk is long enough.
        if (best < end) {
          const candidate = body(start, best);
          for (const separator of ['\n\n', '\n', '. ', '! ', '? ', '; ', ' ']) {
            const at = candidate.lastIndexOf(separator);
            if (at < candidate.length / 2) continue;
            const desired = offset(start) + at + separator.length;
            let index = best;
            while (index > start && offset(index) > desired) index--;
            if (index > start && fits(index)) {
              best = index;
              break;
            }
          }
        }
        const text = body(start, best);
        if (text.trim()) {
          requireValue(
            chunks.length < (options.maxChunks ?? 50_000),
            'CHUNK_LIMIT',
            'The document exceeds the fragment limit. Split it or adjust the limit.',
          );
          const embeddingInput = this.formatter.document(document.name, section.title, text);
          const tokens = encode(best);
          chunks.push({
            index: chunks.length,
            section: section.title,
            body: text,
            embeddingInput,
            tokenCount: tokens.tokenIds.length,
            tokens,
            startLine: section.startLine,
            endLine: section.endLine,
          });
        }
        if (best === end) break;
        // Limit overlap to half the chunk so splitting always makes progress.
        let next = best;
        const minimum = start + Math.ceil((best - start) / 2);
        if (this.config.overlapTokens > 0) {
          let left = minimum;
          let right = best;
          while (left <= right) {
            const middle = Math.floor((left + right) / 2);
            if (
              this.tokenizer.encode(body(middle, best), { includeSpecialTokens: false }).tokenIds
                .length <= this.config.overlapTokens
            ) {
              next = middle;
              right = middle - 1;
            } else left = middle + 1;
          }
        }
        start = next;
      }
    }
    if (!chunks.length) throw new Error('The document has no content to index.');
    return chunks;
  }
}
