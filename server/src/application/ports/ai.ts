import type { ModelProfile, Modality, BillingModality } from '../../contracts/public.js';
export interface AIInput {
  kind: Modality;
  text?: string;
  bytes?: Uint8Array;
  mime?: string;
  seconds?: number;
}
export interface Usage {
  input: number;
  output: number;
  cached: number;
  inputByModality?: Partial<Record<BillingModality, number>>;
  estimated?: boolean;
}
export interface GenerationInput {
  system: string;
  question: AIInput[];
  context: AIInput[];
  history: { role: 'user' | 'assistant'; content: string }[];
}
export interface AIAdapter {
  generate(
    profile: ModelProfile,
    input: GenerationInput,
    signal: AbortSignal,
    onText: (text: string) => void,
  ): Promise<Usage>;
  embed(
    profile: ModelProfile,
    input: AIInput[],
    signal: AbortSignal,
  ): Promise<{ vector: number[]; usage: Usage }>;
  health(profile: ModelProfile, signal: AbortSignal): Promise<void>;
}
