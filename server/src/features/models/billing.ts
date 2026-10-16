import type { BillingBreakdown, BillingModality, ModelProfile } from '../../contracts/public.js';
import type { AIInput, Usage } from '../../application/ports/ai.js';
import { requireValue } from '../../shared/errors.js';

export const billingModalities = ['text', 'image', 'audio', 'video'] as const;
export const emptyInputUsage = () => ({ text: 0, image: 0, audio: 0, video: 0 });
const validCount = (n: number) => Number.isSafeInteger(n) && n >= 0;

// PDF can contain both text and image tokens; video may include an audio track.
export function possibleModalities(parts: AIInput[]): BillingModality[] {
  return [
    ...new Set(
      parts.flatMap((p): BillingModality[] =>
        p.kind === 'pdf' ? ['text', 'image'] : p.kind === 'video' ? ['video', 'audio'] : [p.kind],
      ),
    ),
  ];
}

export function bill(p: ModelProfile, parts: AIInput[], usage: Usage): BillingBreakdown {
  requireValue(
    validCount(usage.input) && validCount(usage.output),
    'INVALID_USAGE',
    'Invalid provider token counts.',
    502,
  );
  const tokens = { ...emptyInputUsage(), ...usage.inputByModality };
  requireValue(
    Object.values(tokens).every(validCount),
    'INVALID_USAGE',
    'Invalid modality token counts.',
    502,
  );
  const known = Object.values(tokens).reduce((a, b) => a + b, 0);
  requireValue(
    known <= usage.input,
    'INVALID_USAGE',
    'Modality counts exceed total input tokens.',
    502,
  );
  const possible = possibleModalities(parts);
  let missing = usage.input - known;
  if (missing && possible.length === 1) {
    tokens[possible[0]!] += missing;
    missing = 0;
  }
  const rate = Math.max(0, ...possible.map((m) => p.inputMicrosPerMillion[m]));
  const entries = [
    ...billingModalities.map((m) => ({
      key: m,
      tokens: tokens[m],
      price: p.inputMicrosPerMillion[m],
    })),
    { key: 'unattributed' as const, tokens: missing, price: rate },
    { key: 'output' as const, tokens: usage.output, price: p.outputMicrosPerMillion },
  ];
  const divisor = 1000000n;
  const amounts = entries.map((e) => BigInt(e.tokens) * BigInt(e.price));
  const total = (amounts.reduce((a, b) => a + b, 0n) + divisor - 1n) / divisor;
  requireValue(
    total <= BigInt(Number.MAX_SAFE_INTEGER),
    'INVALID_USAGE',
    'Usage cost exceeds accounting bounds.',
    502,
  );
  const costs = amounts.map((n) => Number(n / divisor));
  let remainder = Number(total) - costs.reduce((a, b) => a + b, 0);
  // Allocate rounding once per request; the visible lines sum exactly to its total.
  for (const { i } of amounts
    .map((n, i) => ({ i, fraction: n % divisor }))
    .sort((a, b) => Number(b.fraction - a.fraction))) {
    if (!remainder) break;
    costs[i]!++;
    remainder--;
  }
  return {
    input: Object.fromEntries(
      billingModalities.map((m, i) => [m, { tokens: tokens[m], costMicros: costs[i]! }]),
    ) as BillingBreakdown['input'],
    unattributed: { tokens: missing, costMicros: costs[4]!, rateMicrosPerMillion: rate },
    output: { tokens: usage.output, costMicros: costs[5]! },
    prices: { ...p.inputMicrosPerMillion },
    outputPrice: p.outputMicrosPerMillion,
    estimated: Boolean(usage.estimated || missing || usage.cached),
    costMicros: Number(total),
  };
}

export function reservation(p: ModelProfile, parts: AIInput[]) {
  const possible = possibleModalities(parts);
  const mostExpensive = possible.reduce<BillingModality>(
    (a, b) => (p.inputMicrosPerMillion[a] >= p.inputMicrosPerMillion[b] ? a : b),
    possible[0] ?? 'text',
  );
  return bill(p, parts, {
    input: p.contextTokens,
    output: p.role === 'embedding' ? 0 : p.maxOutputTokens,
    cached: 0,
    inputByModality: { [mostExpensive]: p.contextTokens },
    estimated: true,
  });
}

export function googleUsage(metadata: unknown, fallback: number): Usage {
  const m = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
  const inputByModality: Usage['inputByModality'] = {};
  // Embeddings use promptTokenDetails (singular); generation uses promptTokensDetails.
  const details = m.promptTokenDetails ?? m.promptTokensDetails;
  let sum = 0;
  if (Array.isArray(details))
    for (const detail of details) {
      if (!detail || typeof detail !== 'object') continue;
      const d = detail as Record<string, unknown>;
      if (typeof d.tokenCount !== 'number' || !validCount(d.tokenCount)) continue;
      sum += d.tokenCount;
      const kind = String(d.modality).toLowerCase();
      if (billingModalities.includes(kind as BillingModality)) {
        const key = kind as BillingModality;
        inputByModality[key] = (inputByModality[key] ?? 0) + d.tokenCount;
      }
    }
  const reported = typeof m.promptTokenCount === 'number' && validCount(m.promptTokenCount);
  const input = reported ? (m.promptTokenCount as number) : sum || fallback;
  return { input, output: 0, cached: 0, inputByModality, estimated: !reported && !sum };
}
