import { Ollama } from 'ollama';
export interface OllamaConnectionOptions {
  url: string;
  timeoutMs: number;
  keepAlive: string;
}

export function createOllamaClient(config: OllamaConnectionOptions): Ollama {
  return new Ollama({
    host: config.url,
    fetch: (input, init) => {
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      return fetch(input, { ...init, signal });
    },
  });
}

export async function requireModel(client: Ollama, name: string) {
  const expected = name.includes(':') ? name : `${name}:latest`;
  const { models } = await client.list();
  const model = models.find((model) => model.name === expected || model.model === expected);
  if (!model) throw new Error(`Model ${name} is not downloaded. Run ollama pull ${name}.`);
  return model;
}
