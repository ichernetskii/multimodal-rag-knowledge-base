import { randomUUID } from 'node:crypto';
import type { Services } from '../../application/services.js';
import type { Documents } from '../documents/saas-documents.js';
import type { Principal, SyncFolder } from '../../contracts/public.js';
import { string, number, revision, object } from '../../shared/input.js';
import type { Input } from '../../shared/input.js';
import { requireValue } from '../../shared/errors.js';
export class Synchronization {
  constructor(
    readonly s: Services,
    readonly documents: Documents,
  ) {}
  async owned(user: Principal, id: string) {
    const sync = await this.s.db.get<SyncFolder>('sync', id);
    requireValue(
      sync && (sync.owner === user.id || user.role === 'admin'),
      'NOT_FOUND',
      'Connector not found.',
      404,
    );
    await this.documents.collection(user, sync.collection, true);
    return sync;
  }
  async save(user: Principal, p: Input) {
    const id = string(p, 'id', randomUUID()),
      old = await this.s.db.get<SyncFolder>('sync', id);
    if (old) {
      await this.owned(user, id);
      revision(p, old);
    }
    const collection = string(p, 'collection');
    await this.documents.collection(user, collection, true);
    const policy = string(p, 'policy', 'keep');
    requireValue(
      ['keep', 'exclude', 'delete'].includes(policy),
      'INVALID_INPUT',
      'Invalid deletion policy.',
    );
    const sync: SyncFolder = {
      id,
      path: string(p, 'path', '', 1024),
      collection,
      owner: user.id,
      policy: policy as SyncFolder['policy'],
      intervalMinutes: number(p, 'intervalMinutes', 0),
      nextRun: Date.now(),
      mapping: old?.mapping ?? {},
      revision: (old?.revision ?? 0) + 1,
    };
    return this.s.db.put('sync', sync);
  }
  async preview(user: Principal, p: Input) {
    const sync = await this.owned(user, string(p, 'id')),
      raw = p.files;
    requireValue(
      Array.isArray(raw) && raw.length < 100000,
      'INVALID_INPUT',
      'Client file manifest required.',
    );
    const seen = new Set<string>();
    const files = raw.map((value: unknown) => {
      requireValue(value && typeof value === 'object', 'INVALID_INPUT', 'Invalid manifest item.');
      const f = value as Input,
        path = string(f, 'path', '', 4096),
        name = string(f, 'name', '', 255),
        hash = string(f, 'hash'),
        bytes = number(f, 'bytes');
      requireValue(
        path &&
          !path.startsWith('/') &&
          !path.split('/').includes('..') &&
          /^[a-f0-9]{64}$/u.test(hash),
        'INVALID_INPUT',
        'Invalid file manifest.',
      );
      seen.add(path);
      const previous = sync.mapping[path];
      return {
        path,
        name,
        hash,
        bytes,
        status: previous?.hash === hash ? 'unchanged' : previous ? 'update' : 'new',
        document: previous?.document ?? '',
      };
    });
    for (const [path, value] of Object.entries(sync.mapping))
      if (!seen.has(path))
        files.push({
          path,
          name: path.split('/').at(-1)!,
          hash: value.hash,
          bytes: 0,
          status: 'removed',
          document: value.document,
        });
    return { policy: sync.policy, files };
  }
  async report(user: Principal, p: Input) {
    const sync = await this.owned(user, string(p, 'id'));
    revision(p, sync);
    const mapping = object(p, 'mapping');
    requireValue(Object.keys(mapping).length < 100000, 'INVALID_INPUT', 'Manifest too large.');
    for (const [path, value] of Object.entries(mapping)) {
      requireValue(
        path &&
          !path.startsWith('/') &&
          !path.split('/').includes('..') &&
          value &&
          typeof value === 'object',
        'INVALID_INPUT',
        'Invalid mapping.',
      );
      const item = value as Input;
      requireValue(
        /^[a-f0-9]{64}$/u.test(string(item, 'hash')),
        'INVALID_INPUT',
        'Invalid checksum.',
      );
      const doc = await this.documents.document(user, string(item, 'document'), true);
      requireValue(
        doc.collection === sync.collection,
        'INVALID_SCOPE',
        'Document belongs to another knowledge base.',
      );
    }
    sync.mapping = mapping as SyncFolder['mapping'];
    sync.nextRun = Date.now();
    sync.revision++;
    await this.s.db.put('sync', sync);
    return sync;
  }
}
