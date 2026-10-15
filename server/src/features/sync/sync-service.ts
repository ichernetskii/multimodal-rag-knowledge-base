import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat, realpath } from 'node:fs/promises';
import { fileHash } from '../../infrastructure/files/file-hash.js';
import { basename, join, resolve } from 'node:path';
import { authorized, type ActionMap } from '../../application/action-registry.js';
import type { DataContext } from '../../application/data-context.js';
import type { DocumentRecord, Principal, SyncFolder } from '../../domain/entities.js';
import { AppError, requireValue } from '../../shared/errors.js';
import { hash } from '../../shared/hash.js';
import type { Input } from '../../shared/input.js';
import { number, revision, string, supported } from '../../shared/input.js';
import type { DocumentService } from '../documents/document-service.js';

export class SyncService {
  private readonly running = new Set<string>();
  constructor(
    private readonly data: DataContext,
    private readonly documents: DocumentService,
  ) {}
  readonly actions: ActionMap = {
    'sync.list': authorized((user) => this.handleSyncList(user)),
    'sync.save': authorized((user, p) => this.handleSyncSave(user, p)),
    'sync.preview': authorized((user, p) => this.handleSyncPreview(user, p)),
    'sync.run': authorized((user, p) => this.handleSyncRun(user, p)),
    'sync.delete': authorized((user, p) => this.handleSyncDelete(user, p)),
  };
  find(p: Input) {
    const s = this.data.catalog.get<SyncFolder>('sync', string(p, 'id'));
    requireValue(s, 'NOT_FOUND', 'Синхронизация не найдена.', 404);
    return s;
  }

  async preview(s: SyncFolder) {
    const settings = this.data.catalog.settings(),
      byHash = new Map(Object.values(s.mapping).map((value) => [value.hash, value]));
    const seen = new Set<string>();
    const files: { path: string; name: string; hash: string; status: string; document: string }[] =
      [];
    const walk = async (directory: string, depth = 0) => {
      requireValue(depth <= 64, 'DIRECTORY_DEPTH', 'Превышена вложенность каталогов.');
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path, depth + 1);
        else if (entry.isFile()) {
          const relative = path.slice(s.path.length + 1);
          seen.add(relative);
          const bytes = (await stat(path)).size;
          const digest =
            supported(entry.name) && bytes <= settings.maxBytes ? await fileHash(path) : '';
          const previous = s.mapping[relative] ?? (digest ? byHash.get(digest) : undefined);
          files.push({
            path: relative,
            name: entry.name,
            hash: digest,
            status: !supported(entry.name)
              ? 'unsupported'
              : bytes > settings.maxBytes
                ? 'limit'
                : previous?.hash === digest
                  ? 'unchanged'
                  : previous
                    ? 'update'
                    : 'new',
            document: previous?.document ?? '',
          });
          if (files.length > settings.maxDocuments)
            throw new AppError('DOCUMENT_LIMIT', 'Превышен лимит файлов синхронизации.');
        }
      }
    };
    await walk(s.path);
    const presentDocuments = new Set(files.map((file) => file.document));
    for (const [path, mapping] of Object.entries(s.mapping))
      if (!seen.has(path) && !presentDocuments.has(mapping.document))
        files.push({
          path,
          name: basename(path),
          hash: mapping.hash,
          status: 'removed',
          document: mapping.document,
        });
    return { policy: s.policy, files };
  }

  async run(user: Principal, s: SyncFolder) {
    requireValue(!this.running.has(s.id), 'SYNC_BUSY', 'Синхронизация уже выполняется.', 409);
    this.running.add(s.id);
    try {
      return await this.apply(user, s);
    } finally {
      this.running.delete(s.id);
    }
  }
  private async apply(user: Principal, s: SyncFolder) {
    this.data.auth.admin(user);
    const preview = await this.preview(s);
    revision({ revision: s.revision }, this.data.catalog.get<SyncFolder>('sync', s.id)!);
    const results = [];
    try {
      for (const f of preview.files) {
        if (f.status === 'new' || f.status === 'update') {
          const existing = this.data.catalog.get<DocumentRecord>('document', f.document);
          this.data.auth.admin(this.data.auth.current(user.id));
          const content = await readFile(join(s.path, f.path));
          requireValue(
            hash(content) === f.hash,
            'SYNC_CHANGED',
            'Файл изменился во время синхронизации. Обновите предварительный просмотр.',
            409,
          );
          const result = this.documents.upload(user, {
            collection: s.collection,
            name: f.name,
            base64: content.toString('base64'),
            ...(existing ? { document: existing.id, revision: existing.revision } : {}),
          }) as { document: DocumentRecord };
          s.mapping[f.path] = { document: result.document.id, hash: f.hash };
          results.push(result);
        } else if (f.status === 'unchanged')
          s.mapping[f.path] = { document: f.document, hash: f.hash };
        else if (f.status === 'removed') {
          const doc = this.data.catalog.get<DocumentRecord>('document', f.document);
          if (doc && s.policy !== 'keep') {
            this.data.auth.document(user, doc.id, true);
            if (s.policy === 'delete')
              this.data.catalog.transaction(() => this.documents.purge(doc));
            else {
              doc.state = 'excluded';
              doc.revision++;
              this.data.catalog.put('document', doc);
            }
            this.data.catalog.invalidate();
          }
          delete s.mapping[f.path];
        }
      }
      const present = new Set(
        preview.files.filter((file) => file.status !== 'removed').map((file) => file.path),
      );
      for (const path of Object.keys(s.mapping)) if (!present.has(path)) delete s.mapping[path];
    } finally {
      s.revision++;
      this.data.catalog.put('sync', s);
    }
    return { results, preview };
  }

  async handleSyncList(user: Principal) {
    this.data.auth.admin(user);
    return this.data.catalog.list<SyncFolder>('sync');
  }

  async handleSyncSave(user: Principal, p: Input) {
    this.data.auth.admin(user);
    this.data.auth.collection(user, string(p, 'collection'), true);
    const path = await realpath(resolve(string(p, 'path'))).catch(() => {
      throw new AppError('INVALID_DIRECTORY', 'Каталог не существует.');
    });
    requireValue((await stat(path)).isDirectory(), 'INVALID_DIRECTORY', 'Каталог не существует.');
    const policy = string(p, 'policy');
    requireValue(
      ['keep', 'exclude', 'delete'].includes(policy),
      'INVALID_POLICY',
      'Выберите политику удаления.',
    );
    const intervalMinutes = number(p, 'intervalMinutes');
    requireValue(
      Number.isInteger(intervalMinutes) && intervalMinutes >= 0 && intervalMinutes <= 525600,
      'INVALID_INPUT',
      'Некорректное расписание.',
    );
    const id = string(p, 'id', randomUUID());
    const old = this.data.catalog.get<SyncFolder>('sync', id);
    if (old) {
      requireValue(!this.running.has(old.id), 'SYNC_BUSY', 'Синхронизация выполняется.', 409);
      revision(p, old);
      requireValue(
        old.path === path && old.collection === string(p, 'collection'),
        'SYNC_SCOPE_CHANGED',
        'Для другого каталога или базы создайте отдельную синхронизацию.',
      );
    }
    const sync: SyncFolder = {
      id,
      path,
      collection: string(p, 'collection'),
      owner: user.id,
      policy: policy as SyncFolder['policy'],
      intervalMinutes,
      nextRun: Date.now() + intervalMinutes * 60_000,
      mapping: old?.mapping ?? {},
      revision: (old?.revision ?? 0) + 1,
    };
    this.data.catalog.put('sync', sync);
    return sync;
  }

  async handleSyncPreview(user: Principal, p: Input) {
    this.data.auth.admin(user);
    return this.preview(this.find(p));
  }

  async handleSyncRun(user: Principal, p: Input) {
    this.data.auth.admin(user);
    return this.run(user, this.find(p));
  }

  async handleSyncDelete(user: Principal, p: Input) {
    this.data.auth.admin(user);
    const s = this.find(p);
    requireValue(!this.running.has(s.id), 'SYNC_BUSY', 'Синхронизация выполняется.', 409);
    revision(p, s);
    this.data.catalog.delete('sync', s.id);
    return { ok: true };
  }
}
