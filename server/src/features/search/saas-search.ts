import { randomUUID } from 'node:crypto';
import type { Services } from '../../application/services.js';
import type { Documents } from '../documents/saas-documents.js';
import type { Principal, Source, SearchScope } from '../../contracts/public.js';
import type { AIInput } from '../../application/ports/ai.js';
import { containsCode } from '../../shared/input.js';
import { signature } from '../models/ai-service.js';
export class Search {
  constructor(
    readonly s: Services,
    readonly documents: Documents,
  ) {}
  async search(
    user: Principal,
    question: string,
    selection: SearchScope = {},
    parts: AIInput[] = [{ kind: 'text', text: question }],
    job: string = randomUUID(),
    signal = AbortSignal.timeout(60000),
  ) {
    user = await this.s.identity.current(user.id, user.tenant);
    await this.documents.scope(user, { ...selection });
    const index = await this.documents.activeIndex(),
      settings = await this.s.identity.settings();
    const [revisions] = await this.s.db.query<{
      access_revision: string;
      content_revision: string;
    }>('SELECT access_revision,content_revision FROM tenants WHERE id=$1', [user.tenant]);
    const key =
      user.tenant +
      ':search:' +
      signature({
        question,
        parts: parts.map((p) => ({
          ...p,
          bytes: p.bytes ? signature(Buffer.from(p.bytes).toString('base64')) : undefined,
        })),
        selection,
        index: index.id,
        revisions,
        user: user.id,
        groups: user.groups,
        topK: settings.topK,
      });
    const cached = await this.s.cache.get<Source[]>(key);
    if (cached) {
      let valid = true;
      for (const source of cached)
        if (!(await this.documents.permittedSource(user, source))) valid = false;
      if (valid) return cached;
    }
    const collections = (await this.documents.allowedCollections(user)).map((v) => v.id);
    if (selection.collection) collections.splice(0, collections.length, selection.collection);
    const vector = await this.s.ai.embed(index.model, parts, job, signal);
    const values: unknown[] = [
      user.tenant,
      index.id,
      JSON.stringify(vector),
      collections,
      selection.conversation ?? null,
      user.id,
    ];
    const allowed = `c.tenant_id=$1 AND $3::vector IS NOT NULL AND c.index_id=$2 AND d.body->>'state'='published' AND d.body->>'activeVersion'=c.version_id::text AND (d.collection_id=ANY($4::uuid[]) OR (d.conversation_id=$5::uuid AND d.owner_id=$6::uuid))`;
    await this.s.ai.profile(index.profile, 'embedding');
    const nearest = await this.s.db.transaction(async () => {
      await this.s.db.query("SET LOCAL hnsw.iterative_scan='strict_order'");
      return this.s.db.query<{ source_id: string }>(
        `SELECT c.source_id FROM chunks c JOIN documents d ON d.tenant_id=c.tenant_id AND d.id=c.document_id WHERE ${allowed} ${index.model.dimensions === 1536 ? 'AND c.dimensions=1536 ORDER BY c.embedding::vector(1536) <=> $3::vector(1536)' : index.model.dimensions === 768 ? 'AND c.dimensions=768 ORDER BY c.embedding::vector(768) <=> $3::vector(768)' : index.model.dimensions === 3072 ? 'AND c.dimensions=3072 ORDER BY c.embedding::halfvec(3072) <=> $3::halfvec(3072)' : 'ORDER BY c.embedding <=> $3::vector'} LIMIT 100`,
        values,
      );
    });
    const lexical = await this.s.db.query<{ source_id: string }>(
      `SELECT c.source_id FROM chunks c JOIN documents d ON d.tenant_id=c.tenant_id AND d.id=c.document_id WHERE ${allowed} AND c.fts @@ plainto_tsquery('simple',$7) ORDER BY ts_rank_cd(c.fts,plainto_tsquery('simple',$7)) DESC LIMIT 100`,
      [...values, question],
    );
    const codes =
      question.match(/[\p{L}\p{N}_+#]+(?:[./:-][\p{L}\p{N}_+#]+)+|[A-Za-z]+\d[A-Za-z\d_]*/gu) ?? [];
    const exact = codes.length
      ? await this.s.db.query<{ source_id: string; text: string }>(
          `SELECT c.source_id,c.text FROM chunks c JOIN documents d ON d.tenant_id=c.tenant_id AND d.id=c.document_id WHERE ${allowed} AND EXISTS(SELECT 1 FROM unnest($7::text[]) code WHERE strpos(lower(c.text),lower(code))>0) LIMIT 100`,
          [...values, codes],
        )
      : [];
    const rank = new Map<string, number>();
    for (const list of [
      nearest,
      lexical,
      exact.filter((row) =>
        codes.some((code) => containsCode(row.text.toLowerCase(), code.toLowerCase())),
      ),
    ])
      for (const [i, row] of list.entries())
        rank.set(row.source_id, (rank.get(row.source_id) ?? 0) + 1 / (60 + i));
    const ids = [...rank]
      .sort((a, b) => b[1] - a[1])
      .slice(0, settings.topK)
      .map(([id]) => id);
    const result: Source[] = [];
    for (const id of ids) {
      const rows = await this.s.db.query<{ body: Source }>(
        'SELECT body FROM source_fragments WHERE tenant_id=$1 AND id=$2',
        [user.tenant, id],
      );
      const source = rows[0]?.body;
      if (
        source &&
        (await this.documents.permittedSource(
          await this.s.identity.current(user.id, user.tenant),
          source,
        ))
      )
        result.push({ ...source, id: result.length + 1 });
    }
    const [fresh] = await this.s.db.query<{ access_revision: string; content_revision: string }>(
      'SELECT access_revision,content_revision FROM tenants WHERE id=$1',
      [user.tenant],
    );
    if (signature(fresh) === signature(revisions))
      await this.s.cache.put(key, result, settings.cacheSeconds);
    return result;
  }
}
