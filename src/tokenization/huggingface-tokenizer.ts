import { Tokenizer } from '@huggingface/tokenizers';
import { readFile, mkdir, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TokenCounter } from '../core/contracts.js';
import { hash } from '../core/hash.js';

export interface TokenizerAsset {
  name: string;
  bytes: number;
  sha256: string;
}
export interface TokenizerFilesOptions {
  repository: string;
  revision: string;
  directory: string;
  assets: readonly TokenizerAsset[];
  downloadTimeoutMs: number;
}

export class HuggingFaceTokenCounter implements TokenCounter {
  constructor(private readonly tokenizer: Tokenizer) {}
  count(text: string, options?: { includeSpecialTokens?: boolean }): number {
    return this.tokenizer.encode(text, {
      add_special_tokens: options?.includeSpecialTokens ?? true,
    }).ids.length;
  }
}

function verify(data: Uint8Array, asset: TokenizerAsset): void {
  if (data.byteLength !== asset.bytes || hash(data) !== asset.sha256) {
    throw new Error(
      `File ${asset.name} does not match the model profile. Run yarn setup to restore it.`,
    );
  }
}

async function cachedAsset(path: string, asset: TokenizerAsset): Promise<boolean> {
  try {
    verify(await readFile(path), asset);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      ('code' in error ? error.code === 'ENOENT' : error.message.startsWith('File '))
    )
      return false;
    throw error;
  }
}

export async function prepareTokenizer(config: TokenizerFilesOptions): Promise<void> {
  await mkdir(config.directory, { recursive: true });
  for (const asset of config.assets) {
    const path = join(config.directory, asset.name);
    if (await cachedAsset(path, asset)) continue;
    const response = await fetch(
      `https://huggingface.co/${config.repository}/resolve/${config.revision}/${asset.name}`,
      {
        signal: AbortSignal.timeout(config.downloadTimeoutMs),
      },
    );
    if (!response.ok || !response.body)
      throw new Error(`Failed to download ${asset.name}: HTTP ${response.status}.`);
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > asset.bytes)
          throw new Error(`The downloaded file ${asset.name} exceeds its expected size.`);
        parts.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const data = Buffer.concat(parts);
    verify(data, asset);
    JSON.parse(data.toString('utf8'));
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, data, { flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export async function loadTokenizer(config: TokenizerFilesOptions) {
  const files = new Map<string, string>();
  for (const asset of config.assets) {
    let data: Buffer;
    try {
      data = await readFile(join(config.directory, asset.name));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        throw new Error('Tokenizer files are not ready. Run yarn setup.', {
          cause: error,
        });
      throw error;
    }
    verify(data, asset);
    files.set(asset.name, data.toString('utf8'));
  }
  const definition = files.get('tokenizer.json');
  const metadata = files.get('tokenizer_config.json');
  if (definition === undefined || metadata === undefined)
    throw new Error('The profile is missing the two required tokenizer JSON files.');
  const tokenizerJson = JSON.parse(definition) as ConstructorParameters<typeof Tokenizer>[0];
  const tokenizerConfig = JSON.parse(metadata) as ConstructorParameters<typeof Tokenizer>[1];
  return {
    tokenizer: new HuggingFaceTokenCounter(new Tokenizer(tokenizerJson, tokenizerConfig)),
    fingerprint: hash(definition + '\0' + metadata),
  };
}
