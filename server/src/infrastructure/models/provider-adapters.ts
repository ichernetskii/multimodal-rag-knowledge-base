import { createHash } from 'node:crypto';
import type { ModelProfile } from '../../contracts/public.js';
import type { AIAdapter, AIInput, GenerationInput, Usage } from '../../application/ports/ai.js';
import { AppError, requireValue } from '../../shared/errors.js';
import { googleUsage } from '../../features/models/billing.js';

const usage = (): Usage => ({ input: 0, output: 0, cached: 0 });
const words = (s: string) => Math.max(1, Math.ceil(s.length / 4));
const text = (parts: AIInput[]) =>
  parts
    .filter((p) => p.kind === 'text')
    .map((p) => p.text ?? '')
    .join('\n');
const json = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
async function checked(response: Response) {
  if (!response.ok) {
    const status = response.status;
    await response.body?.cancel();
    throw new AppError(
      status === 429
        ? 'PROVIDER_RATE_LIMIT'
        : status >= 500
          ? 'PROVIDER_UNAVAILABLE'
          : 'PROVIDER_REJECTED',
      `AI provider returned HTTP ${status}.`,
      status === 429 ? 429 : 502,
    );
  }
  return response;
}
async function* records(
  response: Response,
  sse: boolean,
  signal: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  await checked(response);
  requireValue(response.body, 'PROVIDER_RESPONSE', 'Provider returned an empty stream.', 502);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      requireValue(
        pending.length <= 2_000_000,
        'PROVIDER_RESPONSE_LIMIT',
        'Provider event is too large.',
        502,
      );
      let at: number;
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at).trim();
        pending = pending.slice(at + 1);
        const data = sse ? (line.startsWith('data:') ? line.slice(5).trim() : '') : line;
        if (data && data !== '[DONE]') {
          try {
            yield json(JSON.parse(data));
          } catch {
            throw new AppError('PROVIDER_RESPONSE', 'Invalid provider stream.', 502);
          }
        }
      }
      if (done) break;
    }
    if (pending.trim() && !sse) yield json(JSON.parse(pending));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function googleParts(parts: AIInput[]) {
  return parts.map((p) =>
    p.kind === 'text'
      ? { text: p.text ?? '' }
      : {
          inlineData: {
            mimeType: p.mime ?? 'application/octet-stream',
            data: Buffer.from(p.bytes ?? []).toString('base64'),
          },
        },
  );
}
export class GoogleAdapter implements AIAdapter {
  constructor(private readonly key: string) {}
  private url(p: ModelProfile, operation: string) {
    return `${p.endpoint.replace(/\/$/u, '')}/v1beta/models/${encodeURIComponent(p.model)}:${operation}`;
  }
  async generate(
    p: ModelProfile,
    input: GenerationInput,
    signal: AbortSignal,
    onText: (t: string) => void,
  ) {
    const r = await fetch(this.url(p, 'streamGenerateContent') + '?alt=sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.key },
      signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: input.system }] },
        contents: [
          ...input.history.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          { role: 'user', parts: googleParts([...input.context, ...input.question]) },
        ],
        generationConfig: { maxOutputTokens: p.maxOutputTokens },
      }),
    });
    const result = usage();
    let transcriptFinished = false;
    for await (const event of records(r, true, signal)) {
      const candidates = event.candidates as
        | { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[]
        | undefined;
      for (const part of candidates?.[0]?.content?.parts ?? [])
        if (part.text && !part.thought) onText(part.text);
      if (p.role === 'transcription' && candidates?.[0]?.finishReason) {
        requireValue(
          candidates[0].finishReason === 'STOP',
          'TRANSCRIPTION_INCOMPLETE',
          'Google did not complete the transcript. Check the output limit or split the recording into shorter segments.',
          502,
        );
        transcriptFinished = true;
      }
      const u = json(event.usageMetadata);
      result.input = count(u.promptTokenCount) || result.input;
      result.output = count(u.candidatesTokenCount) + count(u.thoughtsTokenCount) || result.output;
      result.cached = count(u.cachedContentTokenCount) || result.cached;
      if (u.promptTokenCount !== undefined) {
        const billed = googleUsage(u, p.contextTokens);
        result.inputByModality = billed.inputByModality ?? {};
        result.estimated = Boolean(billed.estimated);
      }
      if (event.error)
        throw new AppError('PROVIDER_RESPONSE', 'Provider reported a generation error.', 502);
    }
    requireValue(
      p.role !== 'transcription' || transcriptFinished,
      'TRANSCRIPTION_INCOMPLETE',
      'Google closed the response before confirming a complete transcript.',
      502,
    );
    if (!result.input) {
      result.input = p.contextTokens;
      result.output = p.maxOutputTokens;
      result.estimated = true;
    }
    return result;
  }
  async embed(p: ModelProfile, input: AIInput[], signal: AbortSignal) {
    const r = await checked(
      await fetch(this.url(p, 'embedContent'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.key },
        signal,
        body: JSON.stringify({
          model: `models/${p.model}`,
          content: { parts: googleParts(input) },
          outputDimensionality: p.dimensions,
        }),
      }),
    );
    const data = (await r.json()) as {
      embedding?: { values?: number[] };
      usageMetadata?: unknown;
    };
    requireValue(data.embedding?.values, 'PROVIDER_RESPONSE', 'Missing embedding.', 502);
    return {
      vector: data.embedding.values,
      usage: googleUsage(data.usageMetadata, p.contextTokens),
    };
  }
  async health(p: ModelProfile, signal: AbortSignal) {
    await checked(
      await fetch(`${p.endpoint}/v1beta/models/${encodeURIComponent(p.model)}`, {
        headers: { 'x-goog-api-key': this.key },
        signal,
      }),
    );
  }
}
export class AnthropicAdapter implements AIAdapter {
  constructor(private readonly key: string) {}
  async generate(
    p: ModelProfile,
    input: GenerationInput,
    signal: AbortSignal,
    onText: (t: string) => void,
  ) {
    const parts = [...input.context, ...input.question].map((part) =>
      part.kind === 'text'
        ? { type: 'text', text: part.text ?? '' }
        : {
            type: part.kind === 'pdf' ? 'document' : 'image',
            source: {
              type: 'base64',
              media_type: part.mime,
              data: Buffer.from(part.bytes ?? []).toString('base64'),
            },
          },
    );
    const r = await fetch(p.endpoint + '/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.key,
        'anthropic-version': '2023-06-01',
      },
      signal,
      body: JSON.stringify({
        model: p.model,
        max_tokens: p.maxOutputTokens,
        system: [
          {
            type: 'text',
            text: input.system,
            ...(p.cache ? { cache_control: { type: 'ephemeral' } } : {}),
          },
        ],
        messages: [...input.history, { role: 'user', content: parts }],
        stream: true,
      }),
    });
    const result = usage();
    for await (const e of records(r, true, signal)) {
      if (e.type === 'error')
        throw new AppError('PROVIDER_RESPONSE', 'Provider reported a generation error.', 502);
      const delta = json(e.delta);
      if (delta.type === 'text_delta' && typeof delta.text === 'string') onText(delta.text);
      const u = json(e.type === 'message_start' ? json(e.message).usage : e.usage);
      result.input = count(u.input_tokens) || result.input;
      result.output = count(u.output_tokens) || result.output;
      result.cached = count(u.cache_read_input_tokens) || result.cached;
    }
    return result;
  }
  embed(): Promise<{ vector: number[]; usage: Usage }> {
    return Promise.reject(
      new AppError('UNSUPPORTED_CAPABILITY', 'This provider profile does not supply embeddings.'),
    );
  }
  async health(p: ModelProfile, signal: AbortSignal) {
    await checked(
      await fetch(p.endpoint + '/v1/models', {
        headers: { 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
        signal,
      }),
    );
  }
}
export class CompatibleAdapter implements AIAdapter {
  constructor(
    private readonly key: string,
    private readonly ollama = false,
  ) {}
  async generate(
    p: ModelProfile,
    input: GenerationInput,
    signal: AbortSignal,
    onText: (t: string) => void,
  ) {
    const parts = [...input.context, ...input.question],
      plain = text(parts),
      images = parts.filter((v) => v.kind === 'image');
    const content = images.length
      ? [
          { type: 'text', text: plain },
          ...images.map((v) => ({
            type: 'image_url',
            image_url: {
              url: `data:${v.mime};base64,${Buffer.from(v.bytes ?? []).toString('base64')}`,
            },
          })),
        ]
      : plain;
    const body = this.ollama
      ? {
          model: p.model,
          stream: true,
          messages: [
            { role: 'system', content: input.system },
            ...input.history,
            {
              role: 'user',
              content: plain,
              images: images.map((v) => Buffer.from(v.bytes ?? []).toString('base64')),
            },
          ],
          options: { num_predict: p.maxOutputTokens, num_ctx: p.contextTokens, temperature: 0 },
          think: false,
        }
      : {
          model: p.model,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: p.maxOutputTokens,
          messages: [
            { role: 'system', content: input.system },
            ...input.history,
            { role: 'user', content },
          ],
        };
    const r = await fetch(p.endpoint + (this.ollama ? '/api/chat' : '/chat/completions'), {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(this.key ? { Authorization: 'Bearer ' + this.key } : {}),
      },
      body: JSON.stringify(body),
    });
    const result = usage();
    for await (const e of records(r, !this.ollama, signal)) {
      if (e.error)
        throw new AppError('PROVIDER_RESPONSE', 'Provider reported a generation error.', 502);
      const choices = e.choices as { delta?: { content?: string } }[] | undefined;
      const value = this.ollama ? json(e.message).content : choices?.[0]?.delta?.content;
      if (typeof value === 'string') onText(value);
      const u = json(e.usage);
      result.input = count(this.ollama ? e.prompt_eval_count : u.prompt_tokens) || result.input;
      result.output = count(this.ollama ? e.eval_count : u.completion_tokens) || result.output;
    }
    return result;
  }
  async embed(p: ModelProfile, input: AIInput[], signal: AbortSignal) {
    requireValue(
      input.every((v) => v.kind === 'text'),
      'UNSUPPORTED_MODALITY',
      'This embedding endpoint accepts text.',
    );
    const r = await checked(
      await fetch(p.endpoint + (this.ollama ? '/api/embed' : '/embeddings'), {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.key ? { Authorization: 'Bearer ' + this.key } : {}),
        },
        body: JSON.stringify({
          model: p.model,
          input: text(input),
          dimensions: p.dimensions,
          ...(this.ollama ? { truncate: false } : {}),
        }),
      }),
    );
    const e = (await r.json()) as {
      embeddings?: number[][];
      data?: { embedding: number[] }[];
      usage?: { prompt_tokens: number };
      prompt_eval_count?: number;
    };
    const vector = this.ollama ? e.embeddings?.[0] : e.data?.[0]?.embedding;
    requireValue(vector, 'PROVIDER_RESPONSE', 'Missing embedding.', 502);
    return {
      vector,
      usage: {
        input: e.usage?.prompt_tokens ?? e.prompt_eval_count ?? words(text(input)),
        output: 0,
        cached: 0,
      },
    };
  }
  async health(p: ModelProfile, signal: AbortSignal) {
    if (this.ollama) {
      const response = await fetch(p.endpoint + '/api/show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: p.model }),
        signal,
      });
      if (response.status === 404) {
        await response.body?.cancel();
        throw new AppError(
          'MODEL_NOT_INSTALLED',
          `Модель ${p.model} не загружена в Ollama. Загрузите её на сервере командой ollama pull ${p.model}.`,
          409,
        );
      }
      const result = json(await (await checked(response)).json());
      const capabilities = Array.isArray(result.capabilities) ? result.capabilities : [];
      requireValue(
        capabilities.includes(p.role === 'embedding' ? 'embedding' : 'completion'),
        'MODEL_CAPABILITY',
        'Загруженная модель не поддерживает выбранную задачу.',
        409,
      );
      requireValue(
        !p.input.includes('image') || capabilities.includes('vision'),
        'MODEL_CAPABILITY',
        'Загруженная модель не поддерживает изображения.',
        409,
      );
      if (p.role === 'embedding') {
        const dimensions = Object.entries(json(result.model_info)).find(([key]) =>
          key.endsWith('.embedding_length'),
        )?.[1];
        requireValue(
          typeof dimensions === 'number' && p.dimensions <= dimensions,
          'MODEL_DIMENSIONS',
          'Размерность embedding-профиля не соответствует загруженной модели.',
          409,
        );
      }
    } else {
      const response = await checked(
        await fetch(p.endpoint + '/models', {
          headers: this.key ? { Authorization: 'Bearer ' + this.key } : {},
          signal,
        }),
      );
      const result = json(await response.json());
      requireValue(
        Array.isArray(result.data) && result.data.some((value) => json(value).id === p.model),
        'MODEL_NOT_INSTALLED',
        'Модель отсутствует в каталоге выбранного сервера.',
        409,
      );
    }
  }
}
export class TestAdapter implements AIAdapter {
  async generate(
    _p: ModelProfile,
    input: GenerationInput,
    signal: AbortSignal,
    onText: (t: string) => void,
  ) {
    const context = text(input.context);
    const selected = /\[\d+\][\s\S]*?(?=\n\[\d+\]|$)/u.exec(context)?.[0];
    const answer = selected
      ? `[TEST AI] ${selected}`
      : '[NO_INFO] [TEST AI] No authorized sources.';
    for (const part of answer.match(/.{1,32}/gsu) ?? []) {
      signal.throwIfAborted();
      onText(part);
      await new Promise((r) => setTimeout(r, 10));
    }
    return { input: words(context + text(input.question)), output: words(answer), cached: 0 };
  }
  async embed(p: ModelProfile, input: AIInput[], signal: AbortSignal) {
    signal.throwIfAborted();
    const vector = Array<number>(p.dimensions).fill(0);
    const tokens =
      text(input)
        .toLowerCase()
        .match(/[\p{L}\p{N}_+-]+/gu) ?? [];
    for (const token of tokens) {
      const digest = createHash('sha256').update(token).digest();
      vector[digest.readUInt32LE(0) % p.dimensions]! += 1;
    }
    if (!tokens.length) vector[0] = 1;
    return { vector, usage: { input: words(text(input)), output: 0, cached: 0 } };
  }
  async health(_p: ModelProfile, signal: AbortSignal) {
    signal.throwIfAborted();
  }
}
