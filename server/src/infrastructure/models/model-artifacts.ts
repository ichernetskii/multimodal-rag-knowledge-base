import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ModelArtifactRepository, ModelArtifacts } from '../../application/ports/embedding.js';
import { hash } from '../../shared/hash.js';

interface ModelAsset {
  name: string;
  bytes: number;
  sha256: string;
}
export interface HuggingFaceArtifactOptions {
  directory: string;
  repository: string;
  revision: string;
  assets: readonly ModelAsset[];
  downloadTimeoutMs: number;
}

/** Stream large weights, verify every asset, and publish each completed file by atomic rename. */
export class HuggingFaceModelRepository implements ModelArtifactRepository {
  constructor(private readonly options: HuggingFaceArtifactOptions) {
    for (const asset of options.assets) {
      if (!/^[\w.-]+(?:\/[\w.-]+)*$/u.test(asset.name) || asset.name.split('/').includes('..'))
        throw new Error('Invalid model asset path.');
      if (
        !Number.isSafeInteger(asset.bytes) ||
        asset.bytes < 1 ||
        !/^[a-f0-9]{64}$/u.test(asset.sha256)
      )
        throw new Error('Invalid model asset integrity metadata.');
    }
  }

  private async valid(asset: ModelAsset): Promise<boolean> {
    const path = join(this.options.directory, asset.name);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size !== asset.bytes) return false;
      const digest = createHash('sha256');
      for await (const part of createReadStream(path)) digest.update(part as Buffer);
      return digest.digest('hex') === asset.sha256;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  private result(): ModelArtifacts {
    return {
      directory: this.options.directory,
      fingerprint: hash(
        JSON.stringify({
          repository: this.options.repository,
          revision: this.options.revision,
          assets: this.options.assets,
        }),
      ),
    };
  }

  async load(): Promise<ModelArtifacts> {
    for (const asset of this.options.assets) {
      if (!(await this.valid(asset)))
        throw new Error(
          'Model file ' +
            asset.name +
            ' is missing or does not match the model profile. Run yarn cli setup.',
        );
    }
    return this.result();
  }

  async prepare(): Promise<ModelArtifacts> {
    for (const asset of this.options.assets) {
      if (await this.valid(asset)) continue;
      const path = join(this.options.directory, asset.name);
      await mkdir(dirname(path), { recursive: true });
      const temporary = path + '.' + randomUUID() + '.tmp';
      const response = await fetch(
        'https://huggingface.co/' +
          this.options.repository +
          '/resolve/' +
          this.options.revision +
          '/' +
          asset.name,
        { signal: AbortSignal.timeout(this.options.downloadTimeoutMs) },
      );
      if (!response.ok || !response.body)
        throw new Error('Failed to download ' + asset.name + ': HTTP ' + response.status + '.');
      const reader = response.body.getReader();
      const file = await open(temporary, 'wx');
      const digest = createHash('sha256');
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > asset.bytes)
            throw new Error('Downloaded model file exceeds its expected size.');
          digest.update(value);
          let offset = 0;
          while (offset < value.byteLength) {
            const written = await file.write(value, offset, value.byteLength - offset);
            if (written.bytesWritten === 0) throw new Error('Failed to write model file.');
            offset += written.bytesWritten;
          }
        }
        if (bytes !== asset.bytes || digest.digest('hex') !== asset.sha256)
          throw new Error(
            'Downloaded model file ' + asset.name + ' does not match the model profile.',
          );
        await file.sync();
        await file.close();
        await rename(temporary, path);
      } finally {
        try {
          await reader.cancel();
        } finally {
          try {
            await file.close();
          } finally {
            await rm(temporary, { force: true });
          }
        }
      }
    }
    return this.result();
  }
}
