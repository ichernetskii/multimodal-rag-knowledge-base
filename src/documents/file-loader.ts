import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { DocumentLoader, LoadedDocument } from '../core/contracts.js';
import { hash } from '../core/hash.js';

export class FileDocumentLoader implements DocumentLoader {
  constructor(private readonly maxBytes: number) {}
  async load(path: string): Promise<LoadedDocument> {
    const physicalPath = await realpath(path);
    const extension = extname(physicalPath).toLowerCase();
    if (!['.md', '.markdown', '.txt'].includes(extension))
      throw new Error('Supported file formats are .md, .markdown, and .txt.');
    const info = await stat(physicalPath);
    if (!info.isFile() || info.size > this.maxBytes)
      throw new Error(`Expected a regular file with a size of at most ${this.maxBytes} bytes.`);
    const buffer = await readFile(physicalPath);
    if (buffer.length > this.maxBytes)
      throw new Error('The document exceeds the maximum allowed size.');
    const text = buffer
      .toString('utf8')
      .replace(/^\uFEFF/u, '')
      .replace(/\r\n?/gu, '\n');
    return {
      id: hash(physicalPath),
      path: physicalPath,
      name: basename(physicalPath),
      format: extension === '.txt' ? 'text' : 'markdown',
      text,
      contentHash: hash(text),
    };
  }
}
