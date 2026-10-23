import type { Services } from '../../application/services.js';
import type { DocumentListItem, DocumentRecord, Job, Principal } from '../../contracts/public.js';
import { number, string, object, type Input } from '../../shared/input.js';
import { requireValue } from '../../shared/errors.js';
import type { Documents } from './saas-documents.js';

/** A page of materials uses a fixed number of queries and never loads version text. */
export class DocumentCatalog {
  constructor(
    private readonly s: Services,
    private readonly documents: Documents,
  ) {}
  async list(user: Principal, input: Input) {
    const page = number(input, 'page', 1),
      pageSize = number(input, 'pageSize', 25);
    requireValue(
      Number.isSafeInteger(page) &&
        page >= 1 &&
        Number.isSafeInteger(pageSize) &&
        pageSize >= 1 &&
        pageSize <= 100,
      'INVALID_INPUT',
      'Invalid material list page.',
    );
    const selection = await this.documents.scope(user, object(input, 'scope'));
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
    const values: unknown[] = [
      user.tenant,
      user.id,
      collections.map((collection) => collection.id),
      editable,
    ];
    const canEdit =
      '(d.conversation_id IS NOT NULL AND d.owner_id=$2 OR d.collection_id=ANY($4::uuid[]))';
    let where = `(d.conversation_id IS NOT NULL AND d.owner_id=$2 OR d.collection_id=ANY($3::uuid[]) AND (${canEdit} OR d.body->>'state'='published' AND d.body->>'activeVersion'<>''))`;
    const add = (value: unknown) => {
      values.push(value);
      return '$' + values.length;
    };
    if (selection.collection) where += ` AND d.collection_id=${add(selection.collection)}`;
    if (selection.conversation) where += ` AND d.conversation_id=${add(selection.conversation)}`;
    else where += ' AND d.conversation_id IS NULL';
    const query = string(input, 'query', '', 200),
      state = string(input, 'state'),
      sort = string(input, 'sort', 'updated');
    requireValue(
      ['', 'published', 'draft', 'excluded', 'archived'].includes(state) &&
        ['name', 'updated', 'state'].includes(sort),
      'INVALID_INPUT',
      'Invalid material filter or sort.',
    );
    if (query)
      where += ` AND d.body->>'name' ILIKE ${add('%' + query.replace(/[\\%_]/gu, '\\$&') + '%')}`;
    if (state) where += ` AND d.body->>'state'=${add(state)}`;
    const [count] = await this.s.db.query<{ total: string }>(
      `SELECT count(*) AS total FROM documents d WHERE d.tenant_id=$1 AND ${where}`,
      values,
    );
    const order =
      sort === 'name'
        ? "lower(d.body->>'name'),d.id"
        : sort === 'state'
          ? "d.body->>'state',lower(d.body->>'name'),d.id"
          : 'v.updated DESC NULLS LAST,d.id';
    const rows = await this.s.db.query<{
      document: DocumentRecord;
      version_count: string;
      updated: string | null;
      job: Job | null;
    }>(
      `SELECT d.body AS document,v.version_count,v.updated,j.body AS job FROM documents d
       LEFT JOIN LATERAL (SELECT count(*) AS version_count,max(created_at) AS updated FROM versions
         WHERE tenant_id=d.tenant_id AND document_id=d.id AND (${canEdit} OR version_state='ready')) v ON true
       LEFT JOIN LATERAL (SELECT body FROM jobs WHERE tenant_id=d.tenant_id AND body->'payload'->>'document'=d.id::text
         AND (${canEdit} OR body->'payload'->>'version'=d.body->>'activeVersion')
         ORDER BY (body->>'created')::bigint DESC,id DESC LIMIT 1) j ON true
       WHERE d.tenant_id=$1 AND ${where} ORDER BY ${order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    const items: DocumentListItem[] = rows.map(({ document, version_count, updated, job }) => ({
      ...document,
      versionCount: Number(version_count),
      updated: Number(updated ?? 0),
      processing: job
        ? {
            id: job.id,
            status: job.status,
            reviewRequired: Boolean(job.result.reviewRequired),
            error: job.error,
            diagnostic: job.diagnostic,
            message: typeof job.result.message === 'string' ? job.result.message : '',
          }
        : null,
    }));
    return { items, total: Number(count?.total ?? 0), page, pageSize };
  }
}
