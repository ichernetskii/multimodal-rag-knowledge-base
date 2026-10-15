import type { Page, Settings, Source, ModelHealth } from '../../contracts/public.js';
import type { Vector } from './embedding.js';
export interface EmbeddedFragment {
  page: number;
  section: string;
  body: string;
  vector: Vector;
}
export interface ModelRuntime {
  configuration?(): Record<string, unknown>;
  restoreConfiguration?(value: Record<string, unknown>): Promise<void>;
  signature(): Promise<string>;
  query(question: string): Promise<Vector>;
  index(
    name: string,
    pages: Page[],
    signal: AbortSignal,
    options: { maxChunks: number; beforeBatch?: () => Promise<void> },
  ): Promise<EmbeddedFragment[]>;
  generate(
    question: string,
    sources: Source[],
    history: { role: 'user' | 'assistant'; content: string }[],
    settings: Settings,
    signal: AbortSignal,
    onToken: (token: string) => void,
  ): Promise<{ answer: string; insufficient: boolean; clarification?: boolean }>;
  health(model?: string): Promise<ModelHealth>;
  close(): Promise<void>;
}
