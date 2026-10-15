import { randomUUID } from 'node:crypto';
import { authorized, type ActionMap } from '../../application/action-registry.js';
import type { DataContext } from '../../application/data-context.js';
import type { Collection, Principal } from '../../domain/entities.js';
import { requireValue } from '../../shared/errors.js';
import type { Input } from '../../shared/input.js';
import { revision, string } from '../../shared/input.js';

export class CollectionService {
  constructor(private readonly data: DataContext) {}
  readonly actions: ActionMap = {
    'collections.list': authorized((user) => this.handleCollectionsList(user)),
    'collections.rename': authorized((user, p) => this.handleCollectionsRename(user, p)),
    'collections.save': authorized((user, p) => this.handleCollectionsSave(user, p)),
  };
  list(user: Principal) {
    const collections = this.data.auth.collections(user);
    const access = this.data.auth.documentScope(user),
      counts = new Map(
        this.data.catalog
          .prepare(
            `SELECT collection,count(*) AS n FROM entities WHERE kind='document' AND (${access.where}) AND conversation='' GROUP BY collection`,
          )
          .all(...access.params)
          .map((row) => [String(row.collection), Number(row.n)]),
      );
    const subjects = new Set([user.id, ...user.groups.map((id) => 'group:' + id)]);
    return collections.map((collection) => ({
      ...collection,
      grants:
        user.role === 'admin'
          ? collection.grants
          : collection.grants.filter((grant) => subjects.has(grant.subject)),
      documentCount: counts.get(collection.id) ?? 0,
    }));
  }

  async handleCollectionsList(user: Principal) {
    return this.list(user);
  }

  async handleCollectionsRename(user: Principal, p: Input) {
    const c = this.data.auth.collection(user, string(p, 'id'), true);
    revision(p, c);
    const name = string(p, 'name');
    requireValue(name.trim(), 'INVALID_INPUT', 'Введите название базы.');
    c.name = name;
    c.revision++;
    this.data.catalog.transaction(() => {
      this.data.catalog.put('collection', c);
      this.data.catalog.invalidate();
    });
    return user.role === 'admin'
      ? c
      : {
          ...c,
          grants: c.grants.filter(
            (grant) =>
              grant.subject === user.id ||
              user.groups.some((id) => grant.subject === 'group:' + id),
          ),
        };
  }

  async handleCollectionsSave(user: Principal, p: Input) {
    this.data.auth.admin(user);
    const id = string(p, 'id', randomUUID());
    const old = this.data.catalog.get<Collection>('collection', id);
    if (old) revision(p, old);
    const grants = p.grants ?? [];
    requireValue(
      Array.isArray(grants) && grants.length <= 1000,
      'INVALID_INPUT',
      'Некорректные разрешения.',
    );
    const parsed = grants.map((v: unknown) => {
      requireValue(v && typeof v === 'object', 'INVALID_INPUT', 'Некорректное разрешение.');
      const g = v as Input;
      const subject = string(g, 'subject');
      const access = string(g, 'access');
      requireValue(['read', 'edit'].includes(access), 'INVALID_INPUT', 'Некорректное разрешение.');
      requireValue(
        subject.startsWith('group:')
          ? this.data.catalog.get('group', subject.slice(6))
          : this.data.catalog.get('user', subject),
        'INVALID_SUBJECT',
        'Пользователь или группа не найдены.',
      );
      return { subject, access: access as 'read' | 'edit' };
    });
    requireValue(
      new Set(parsed.map((grant) => grant.subject)).size === parsed.length,
      'INVALID_INPUT',
      'Не повторяйте назначение одному пользователю или группе.',
    );
    const c: Collection = {
      id,
      name: string(p, 'name'),
      revision: (old?.revision ?? 0) + 1,
      grants: parsed,
    };
    requireValue(c.name.trim(), 'INVALID_INPUT', 'Введите название базы.');
    this.data.catalog.transaction(() => {
      this.data.catalog.put('collection', c);
      this.data.catalog.invalidate(true);
    });
    return c;
  }
}
