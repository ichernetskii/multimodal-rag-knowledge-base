import { randomUUID } from 'node:crypto';
import type { Services } from '../../application/services.js';
import type { Collection, DocumentRecord, Principal } from '../../contracts/public.js';
import type { Documents } from '../documents/saas-documents.js';
import { revision, string } from '../../shared/input.js';
import type { Input } from '../../shared/input.js';
import { requireValue } from '../../shared/errors.js';

/** Knowledge-base mutations share the access lock with document and grant changes. */
export class KnowledgeBases {
  constructor(
    private readonly s: Services,
    private readonly documents: Documents,
  ) {}

  async list(user: Principal) {
    const collections = await this.documents.allowedCollections(user);
    const editable = collections
      .filter(
        (collection) =>
          user.role === 'admin' ||
          (user.role === 'editor' &&
            collection.grants.some(
              (grant) =>
                grant.access === 'edit' &&
                (grant.subject === user.id ||
                  user.groups.some((id) => grant.subject === 'group:' + id)),
            )),
      )
      .map((collection) => collection.id);
    const counts = new Map(
      (
        await this.s.db.query<{ collection_id: string; count: string }>(
          "SELECT collection_id,count(*) FROM documents WHERE tenant_id=$1 AND collection_id=ANY($2::uuid[]) AND (collection_id=ANY($3::uuid[]) OR body->>'state'='published' AND body->>'activeVersion'<>'') GROUP BY collection_id",
          [user.tenant, collections.map((c) => c.id), editable],
        )
      ).map((row) => [row.collection_id, Number(row.count)]),
    );
    return collections.map((collection) => ({
      ...collection,
      grants:
        user.role === 'admin'
          ? collection.grants
          : collection.grants.filter(
              (g) => g.subject === user.id || user.groups.some((id) => g.subject === 'group:' + id),
            ),
      documentCount: counts.get(collection.id) ?? 0,
    }));
  }

  async save(user: Principal, input: Input) {
    this.s.identity.admin(user);
    return this.s.db.transaction(async () => {
      await this.s.db.lock('access');
      const id = string(input, 'id', randomUUID()),
        old = await this.s.db.get<Collection>('collection', id);
      if (old) revision(input, old);
      const raw = input.grants;
      requireValue(Array.isArray(raw) && raw.length <= 1000, 'INVALID_INPUT', 'Invalid grants.');
      const grants: Collection['grants'] = [];
      for (const value of raw) {
        requireValue(value && typeof value === 'object', 'INVALID_INPUT', 'Invalid grant.');
        const grant = value as Input,
          subject = string(grant, 'subject'),
          access = string(grant, 'access');
        requireValue(
          access === 'read' || access === 'edit',
          'INVALID_INPUT',
          'Invalid permission.',
        );
        const exists = subject.startsWith('group:')
          ? await this.s.db.get('group', subject.slice(6))
          : (
              await this.s.db.query('SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
                user.tenant,
                subject,
              ])
            )[0];
        requireValue(exists, 'INVALID_SUBJECT', 'Member or group does not exist.');
        grants.push({ subject, access });
      }
      requireValue(
        new Set(grants.map((g) => g.subject)).size === grants.length,
        'INVALID_INPUT',
        'Duplicate grants.',
      );
      const collection = {
        id,
        name: string(input, 'name', '', 200),
        revision: (old?.revision ?? 0) + 1,
        grants,
      };
      requireValue(collection.name.trim(), 'INVALID_INPUT', 'Knowledge base name is required.');
      await this.s.db.put('collection', collection);
      await this.s.db.invalidate(true);
      await this.s.identity.audit(user.id, 'collections.save', id);
      return collection;
    });
  }

  async rename(user: Principal, input: Input) {
    return this.s.db.transaction(async () => {
      await this.s.db.lock('access');
      const collection = await this.documents.collection(user, string(input, 'id'), true);
      revision(input, collection);
      collection.name = string(input, 'name', '', 200);
      requireValue(collection.name.trim(), 'INVALID_INPUT', 'Name is required.');
      collection.revision++;
      await this.s.db.put('collection', collection);
      await this.s.db.invalidate();
      await this.s.identity.audit(user.id, 'collections.rename', collection.id);
      return collection;
    });
  }

  async remove(user: Principal, input: Input) {
    this.s.identity.admin(user);
    return this.s.db.transaction(async () => {
      await this.s.db.lock('access');
      const collection = await this.documents.collection(user, string(input, 'id'), true);
      revision(input, collection);
      for (const document of await this.s.db.list<DocumentRecord>(
        'document',
        'collection_id=$2',
        [collection.id],
        100000,
      ))
        await this.documents.remove(user, document.id);
      await this.s.db.remove('collection', collection.id);
      await this.s.db.invalidate(true);
      await this.s.identity.audit(user.id, 'collections.delete', collection.id);
      return { ok: true };
    });
  }
}
