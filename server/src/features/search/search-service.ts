import { setImmediate as yieldToIO } from 'node:timers/promises';
import { authorized, type ActionMap } from '../../application/action-registry.js';
import type { DataContext } from '../../application/data-context.js';
import type { DocumentRecord, Principal, SearchScope, Source } from '../../domain/entities.js';
import type { CacheStore } from '../../infrastructure/database/cache-store.js';
import { VectorCache } from '../../infrastructure/indexing/vector-cache.js';
import { dot } from '../../infrastructure/indexing/vector-codec.js';
import { requireValue } from '../../shared/errors.js';
import { hash } from '../../shared/hash.js';
import type { Input } from '../../shared/input.js';
import { containsCode, object, scope, string } from '../../shared/input.js';
import type { AccessPolicy } from '../identity/access-policy.js';
import { CandidateHeap } from './ranking.js';
export class SearchService {
  private readonly vectors = new VectorCache();
  private vectorEpoch = -1;
  constructor(
    private readonly data: DataContext,
    private readonly access: AccessPolicy,
    private readonly cache: CacheStore,
  ) {}
  readonly actions: ActionMap = { search: authorized((user, p) => this.handleSearch(user, p)) };
  get stats() {
    return this.vectors.stats;
  }
  matching(user: Principal, selection: SearchScope) {
    const access = this.data.auth.documentScope(user);
    return this.data.catalog.find<DocumentRecord>(
      'document',
      `${access.where} AND state='published' AND (conversation='' OR conversation=?) AND (?='' OR conversation!='' OR collection=?)`,
      [
        ...access.params,
        selection.conversation ?? '',
        selection.collection ?? '',
        selection.collection ?? '',
      ],
    );
  }
  async search(
    user: Principal,
    question: string,
    selection: SearchScope,
    attempt = 0,
  ): Promise<Source[]> {
    requireValue(
      question.trim() && question.length <= 5000,
      'QUESTION_LIMIT',
      'Введите вопрос до 5000 символов.',
    );
    user = this.data.auth.current(user.id);
    if (selection.collection) this.data.auth.collection(user, selection.collection);
    if (selection.conversation) this.access.owns(user, selection.conversation);
    const epoch = this.data.catalog.epoch(),
      settings = this.data.catalog.settings(),
      key = hash(
        JSON.stringify({
          kind: 'search',
          user: user.id,
          epoch,
          question,
          selection,
          topK: settings.topK,
        }),
      );
    // Cache lookup precedes any vector scan or version/page decoding. ACL is always fresh.
    const cached = this.data.catalog
      .prepare('SELECT body FROM cache WHERE key=? AND created>?')
      .get(key, Date.now() - 86400_000);
    if (cached) {
      const value = JSON.parse(String(cached.body)) as Source[];
      if (value.every((source) => this.access.source(user, source))) return value;
    }
    const documents = this.matching(user, selection);
    if (!documents.length) {
      this.cache.put(key, []);
      return [];
    }
    const vector = await this.data.models.query(question),
      signature = await this.data.models.signature();
    if (epoch !== this.data.catalog.epoch()) {
      requireValue(
        attempt < 1,
        'SEARCH_CHANGED',
        'Данные изменились во время поиска. Повторите запрос.',
        409,
      );
      return this.search(user, question, selection, attempt + 1);
    }
    const allowed = new Map(documents.map((doc) => [doc.id, doc])),
      ids = JSON.stringify([...allowed.keys()]);
    const mismatch = this.data.catalog
      .prepare(
        "SELECT 1 FROM entities d JOIN entities v ON v.kind='version' AND v.id=d.active_version WHERE d.kind='document' AND d.id IN (SELECT value FROM json_each(?)) AND (v.state!='ready' OR v.signature!=?) LIMIT 1",
      )
      .get(ids, signature);
    requireValue(
      !mismatch,
      'INDEX_INCOMPATIBLE',
      'Переиндексируйте документы для текущей модели.',
      409,
    );
    if (this.vectorEpoch !== epoch) {
      this.vectors.clear();
      this.vectorEpoch = epoch;
    }
    const words = (question.match(/[\p{L}\p{N}][\p{L}\p{N}_.:/+#-]*/gu) ?? []).map((word) =>
      word.replace(/[.:]+$/u, ''),
    );
    const exact = words
      .filter((word) => /\d|[._:/+#-]/u.test(word))
      .map((word) => word.toLowerCase());
    const fts = words.map((word) => '"' + word.replaceAll('"', '""') + '"').join(' OR '),
      lexical = new Map<string, number>();
    if (fts) {
      const hits = this.data.catalog
        .prepare(
          "SELECT c.id,bm25(fulltext,0,1,0.4) AS rank FROM fulltext JOIN chunks c ON c.id=fulltext.id JOIN entities d ON d.kind='document' AND d.id=c.document AND d.active_version=c.version WHERE fulltext MATCH ? AND d.id IN (SELECT value FROM json_each(?)) ORDER BY rank,c.id LIMIT 256",
        )
        .all(fts, ids);
      hits.forEach((row, index) => lexical.set(String(row.id), index));
    }
    const semantic = new CandidateHeap(Math.max(64, settings.topK * 8)),
      similarities = new Map<string, number>();
    let scanned = 0;
    // A dedicated statement owns this cursor; concurrent searches cannot reset a shared iterator.
    const rows = this.data.catalog.db
      .prepare(
        "SELECT c.id,c.document,c.version,c.vector FROM chunks c JOIN entities d ON d.kind='document' AND d.id=c.document AND d.active_version=c.version WHERE d.id IN (SELECT value FROM json_each(?))",
      )
      .iterate(ids);
    for (const row of rows) {
      const id = String(row.id),
        values = this.vectors.get(id, row.vector as Uint8Array);
      requireValue(
        values.length === vector.length,
        'INDEX_INCOMPATIBLE',
        'Размерность индекса несовместима с моделью.',
        409,
      );
      const similarity = dot(values, vector);
      semantic.add({
        id,
        document: String(row.document),
        version: String(row.version),
        similarity,
      });
      if (lexical.has(id)) similarities.set(id, similarity);
      if (++scanned % 4096 === 0) await yieldToIO();
    }
    const best = semantic.sorted(),
      ranks = new Map(best.map((candidate, index) => [candidate.id, index]));
    const candidates = JSON.stringify([...new Set([...ranks.keys(), ...lexical.keys()])]);
    const texts = this.data.catalog
      .prepare(
        'SELECT id,document,version,page,section,body FROM chunks WHERE id IN (SELECT value FROM json_each(?))',
      )
      .all(candidates);
    const ordered = texts
      .map((row) => {
        const id = String(row.id),
          doc = allowed.get(String(row.document))!,
          body = [row.body, row.section, doc.name].join(' ').toLowerCase(),
          matches = exact.filter((code) => containsCode(body, code)).length;
        const semanticRank = ranks.get(id),
          lexicalRank = lexical.get(id);
        return {
          row,
          similarity:
            similarities.get(id) ?? best.find((candidate) => candidate.id === id)?.similarity ?? -1,
          matches,
          score:
            matches * 2 +
            (semanticRank === undefined ? 0 : 1 / (60 + semanticRank)) +
            (lexicalRank === undefined ? 0 : 1 / (60 + lexicalRank)),
        };
      })
      .filter((candidate) =>
        exact.length
          ? candidate.matches > 0
          : lexical.has(String(candidate.row.id)) || candidate.similarity >= 0.35,
      )
      .sort((a, b) => b.score - a.score || String(a.row.id).localeCompare(String(b.row.id)))
      .slice(0, settings.topK);
    if (epoch !== this.data.catalog.epoch()) {
      requireValue(
        attempt < 1,
        'SEARCH_CHANGED',
        'Данные изменились во время поиска. Повторите запрос.',
        409,
      );
      return this.search(user, question, selection, attempt + 1);
    }
    user = this.data.auth.current(user.id);
    const result = ordered.map(({ row }, index) => ({
      id: index + 1,
      chunk: String(row.id),
      document: String(row.document),
      version: String(row.version),
      name: allowed.get(String(row.document))!.name,
      page: Number(row.page),
      section: String(row.section),
      text: String(row.body),
    }));
    requireValue(
      result.every((source) => this.access.source(user, source)),
      'ACCESS_REVOKED',
      'Доступ к источникам отозван.',
      403,
    );
    this.data.catalog.transaction(() => {
      const insert = this.data.catalog.prepare(
        'INSERT OR IGNORE INTO source_fragments VALUES (?,?,?,?,?,?,?)',
      );
      for (const source of result)
        insert.run(
          source.chunk,
          source.document,
          source.version,
          source.page,
          source.section,
          source.text,
          Date.now(),
        );
      this.cache.put(key, result);
    });
    return result;
  }
  async handleSearch(user: Principal, input: Input) {
    return this.search(user, string(input, 'question'), scope(object(input, 'scope')));
  }
}
