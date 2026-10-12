import type { AppConfig } from '../config.js';
import type {
  DocumentChunk,
  DocumentChunker,
  DocumentSection,
  EmbeddingFormatter,
  LoadedDocument,
  TokenCounter,
} from '../core/contracts.js';

/** Count the complete model input instead of adding individual word token counts. */
export class TokenDocumentChunker implements DocumentChunker {
  constructor(
    private readonly tokenizer: TokenCounter,
    private readonly formatter: EmbeddingFormatter,
    private readonly config: AppConfig['chunking'],
    private readonly maxInputTokens: number,
  ) {}

  async chunk(
    document: LoadedDocument,
    sections: readonly DocumentSection[],
  ): Promise<DocumentChunk[]> {
    const chunks: DocumentChunk[] = [];
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const section of sections) {
      if (
        this.tokenizer.count(this.formatter.document(document.name, section.title, '')) + 8 >
        this.config.targetTokens
      ) {
        throw new Error(`The section title is too long: ${section.title}.`);
      }
      const positions = [0];
      for (const item of segmenter.segment(section.text))
        positions.push(item.index + item.segment.length);
      const end = positions.length - 1;
      const offset = (index: number) => {
        const value = positions[index];
        if (value === undefined) throw new Error('Invalid chunk boundary.');
        return value;
      };
      const body = (start: number, stop: number) => section.text.slice(offset(start), offset(stop));
      let start = 0;
      while (start < end) {
        const counts = new Map<number, number>();
        const fits = (stop: number) => {
          let tokens = counts.get(stop);
          if (tokens === undefined) {
            tokens = this.tokenizer.count(
              this.formatter.document(document.name, section.title, body(start, stop)),
            );
            counts.set(stop, tokens);
          }
          return (
            tokens <= Math.min(this.config.targetTokens, this.maxInputTokens) &&
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
          const embeddingInput = this.formatter.document(document.name, section.title, text);
          chunks.push({
            index: chunks.length,
            section: section.title,
            body: text,
            embeddingInput,
            tokenCount: this.tokenizer.count(embeddingInput),
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
              this.tokenizer.count(body(middle, best), { includeSpecialTokens: false }) <=
              this.config.overlapTokens
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
