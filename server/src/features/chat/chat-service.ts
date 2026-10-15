import { randomUUID } from 'node:crypto';
import { authorized, type ActionMap } from '../../application/action-registry.js';
import type { DataContext } from '../../application/data-context.js';
import type {
  Conversation,
  DocumentRecord,
  Job,
  Principal,
  Turn,
  TurnVariant,
} from '../../domain/entities.js';
import type { CacheStore } from '../../infrastructure/database/cache-store.js';
import { requireValue } from '../../shared/errors.js';
import { hash } from '../../shared/hash.js';
import type { Input } from '../../shared/input.js';
import { localized, object, revision, scope, string } from '../../shared/input.js';
import { pagination } from '../../shared/pagination.js';
import type { DocumentService } from '../documents/document-service.js';
import type { AccessPolicy } from '../identity/access-policy.js';
import type { JobService } from '../jobs/job-service.js';
import type { SearchService } from '../search/search-service.js';

export class ChatService {
  constructor(
    private readonly access: AccessPolicy,
    private readonly data: DataContext,
    private readonly jobs: JobService,
    private readonly search: SearchService,
    private readonly cache: CacheStore,
    private readonly documents: DocumentService,
  ) {}
  readonly actions: ActionMap = {
    'conversations.list': authorized((user, p) => this.handleConversationsList(user, p)),
    'conversations.create': authorized((user, p) => this.handleConversationsCreate(user, p)),
    'conversations.variants': authorized((user, p) => this.handleConversationsVariants(user, p)),
    'conversations.read': authorized((user, p) => this.handleConversationsRead(user, p)),
    'conversations.save': authorized((user, p) => this.handleConversationsSave(user, p)),
    'conversations.delete': authorized((user, p) => this.handleConversationsDelete(user, p)),
    'answers.create': authorized((user, p) => this.handleAnswersCreate(user, p)),
  };
  createAnswer(user: Principal, p: Input) {
    const conversation = this.access.owns(user, string(p, 'conversation'));
    revision(p, conversation);
    const question = string(p, 'question');
    requireValue(
      question.trim() && question.length <= 5000,
      'QUESTION_LIMIT',
      'Введите вопрос до 5000 символов.',
    );
    const replaces = string(p, 'replaces');
    const old = replaces ? this.data.catalog.get<Turn>('turn', replaces) : undefined;
    requireValue(
      !replaces || old?.conversation === conversation.id,
      'INVALID_BRANCH',
      'Ответ не принадлежит диалогу.',
    );
    const parent = old?.parent ?? conversation.selected;
    const inherited = old?.scope ?? this.data.catalog.get<Turn>('turn', parent)?.scope ?? {};
    const f = scope(p.scope === undefined ? { ...inherited } : object(p, 'scope'));
    f.conversation = conversation.id;
    if (f.collection) this.data.auth.collection(user, f.collection);
    const t: Turn = {
      id: randomUUID(),
      conversation: conversation.id,
      parent,
      replaces,
      question,
      answer: '',
      sources: [],
      status: 'queued',
      job: '',
      created: Date.now(),
      scope: f,
    };
    return this.data.catalog.transaction(() => {
      const job = this.jobs.create(user, 'answer', { turn: t.id, conversation: conversation.id });
      t.job = job.id;
      this.data.catalog.put('turn', t);
      conversation.selected = t.id;
      conversation.draft = '';
      conversation.updated = Date.now();
      conversation.revision++;
      if (conversation.title === 'Новый диалог') conversation.title = question.slice(0, 80);
      this.data.catalog.put('conversation', conversation);
      return { turn: t, job, conversation };
    });
  }

  history(user: Principal, t: Turn) {
    const result: { role: 'user' | 'assistant'; content: string }[] = [];
    let parent = t.parent;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const item = this.data.catalog.get<Turn>('turn', parent);
      if (!item || item.conversation !== t.conversation) break;
      if (
        item.status === 'complete' &&
        [...item.sources, ...(item.accessSources ?? [])].every((s) => this.access.source(user, s))
      )
        result.unshift(
          { role: 'user', content: item.question },
          { role: 'assistant', content: item.answer },
        );
      if (result.length >= 8) break;
      parent = item.parent;
    }
    return result;
  }

  async process(job: Job, user: Principal, signal: AbortSignal) {
    const t = this.data.catalog.get<Turn>('turn', string(job.payload, 'turn'));
    requireValue(t, 'NOT_FOUND', 'Вопрос не найден.');
    this.access.owns(user, t.conversation);
    t.status = 'searching';
    this.data.catalog.put('turn', t);
    this.jobs.update(job, { status: 'searching' });
    const sources = await this.search.search(user, t.question, t.scope);
    signal.throwIfAborted();
    t.sources = sources;
    if (!sources.length) {
      t.status = 'no_info';
      t.answer = localized(
        t.question,
        'В доступных документах недостаточно информации.',
        'The accessible documents do not contain enough information.',
      );
    } else {
      const settings = this.data.catalog.settings();
      const budget = 12_000 - settings.prompt.length - t.question.length;
      let used = 0;
      t.sources = t.sources
        .filter((s) => {
          used += JSON.stringify(s).length;
          return used <= budget;
        })
        .map((s, i) => ({ ...s, id: i + 1 }));
      requireValue(t.sources.length, 'CONTEXT_LIMIT', 'Источники не помещаются в контекст.');
      t.status = 'generating';
      t.accessSources = [];
      let ancestor = t.parent;
      const seen = new Set<string>();
      let count = 0;
      while (ancestor && !seen.has(ancestor) && count < 4) {
        seen.add(ancestor);
        const prior = this.data.catalog.get<Turn>('turn', ancestor);
        if (!prior || prior.conversation !== t.conversation) break;
        const guarded = [...prior.sources, ...(prior.accessSources ?? [])];
        if (prior.status === 'complete' && guarded.every((s) => this.access.source(user, s))) {
          t.accessSources.push(
            ...guarded.map((s) => ({ document: s.document, version: s.version, chunk: s.chunk })),
          );
          count++;
        }
        ancestor = prior.parent;
      }
      t.accessSources = [...new Map(t.accessSources.map((s) => [s.chunk, s])).values()];
      this.data.catalog.put('turn', t);
      this.jobs.update(job, { status: 'generating', settings: this.jobs.configuration() });
      const cacheKey = hash(
        JSON.stringify({
          kind: 'answer',
          user: user.id,
          epoch: this.data.catalog.epoch(),
          question: t.question,
          scope: t.scope,
          parent: t.parent,
          settings,
          sources: t.sources,
        }),
      );
      const cache = this.data.catalog.prepare('SELECT body FROM cache WHERE key=?').get(cacheKey);
      let lastWrite = 0;
      let dirty = false;
      const persistPartial = () => {
        if (!dirty) return;
        const exists = this.data.catalog
          .prepare("SELECT 1 FROM entities WHERE kind='turn' AND id=?")
          .get(t.id);
        let allowed: boolean;
        try {
          const current = this.data.auth.current(user.id);
          allowed = [...t.sources, ...(t.accessSources ?? [])].every((source) =>
            this.access.source(current, source),
          );
        } catch {
          allowed = false;
        }
        if (!exists || !allowed) {
          dirty = false;
          return;
        }
        this.data.catalog.transaction(() => {
          this.data.catalog.put('turn', t);
          this.jobs.update(job, { status: 'generating' });
        });
        dirty = false;
        lastWrite = Date.now();
      };
      let reply;
      try {
        reply = cache
          ? (JSON.parse(String(cache.body)) as {
              answer: string;
              insufficient: boolean;
              clarification?: boolean;
            })
          : await this.data.models.generate(
              t.question,
              t.sources,
              this.history(user, t),
              settings,
              signal,
              (token) => {
                const current = this.data.auth.current(user.id);
                requireValue(
                  [...t.sources, ...(t.accessSources ?? [])].every((s) =>
                    this.access.source(current, s),
                  ),
                  'ACCESS_REVOKED',
                  'Доступ к источникам отозван.',
                  403,
                );
                signal.throwIfAborted();
                t.answer += token;
                t.status = 'generating';
                dirty = true;
                if (Date.now() - lastWrite >= 100) persistPartial();
              },
            );
      } finally {
        persistPartial();
      }
      signal.throwIfAborted();
      const current = this.data.auth.current(user.id);
      requireValue(
        [...t.sources, ...(t.accessSources ?? [])].every((s) => this.access.source(current, s)),
        'ACCESS_REVOKED',
        'Доступ к источникам отозван.',
        403,
      );
      t.answer = reply.answer;
      t.status = reply.insufficient
        ? 'no_info'
        : reply.clarification
          ? 'clarification'
          : 'complete';
      this.cache.put(cacheKey, reply);
    }
    this.data.catalog.put('turn', t);
    this.jobs.update(job, { status: t.status, result: { turn: t.id } });
  }

  async handleConversationsList(user: Principal, p: Input) {
    const q = string(p, 'query').toLowerCase(),
      page = pagination(p);
    const where = `owner=? AND (?='' OR instr(search_name,?)>0 OR EXISTS (SELECT 1 FROM entities AS turns WHERE turns.kind='turn' AND turns.conversation=entities.id AND instr(turns.search_text,?)>0))`,
      params = [user.id, q, q, q];
    return {
      items: this.data.catalog.find<Conversation>(
        'conversation',
        where,
        params,
        'updated DESC',
        page.pageSize,
        page.offset,
      ),
      total: this.data.catalog.count('conversation', where, params),
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async handleConversationsCreate(user: Principal, p: Input) {
    const c: Conversation = {
      id: randomUUID(),
      owner: user.id,
      title: string(p, 'title', 'Новый диалог'),
      draft: '',
      selected: '',
      revision: 1,
      updated: Date.now(),
    };
    this.data.catalog.put('conversation', c);
    return c;
  }

  async handleConversationsRead(user: Principal, p: Input) {
    const conversation = this.access.owns(user, string(p, 'id')),
      page = pagination({ pageSize: p.pageSize ?? 40 });
    let cursor = conversation.selected;
    const before = string(p, 'before');
    if (before) {
      const anchor = this.data.catalog.get<Turn>('turn', before);
      requireValue(
        anchor?.conversation === conversation.id,
        'INVALID_BRANCH',
        'Сообщение не принадлежит диалогу.',
      );
      cursor = anchor.parent;
    }
    const turns: Turn[] = [],
      seen = new Set<string>();
    while (cursor && turns.length < page.pageSize && !seen.has(cursor)) {
      seen.add(cursor);
      const turn = this.data.catalog.get<Turn>('turn', cursor);
      if (!turn || turn.conversation !== conversation.id) {
        cursor = '';
        break;
      }
      turns.push(this.access.turn(user, turn));
      cursor = turn.parent;
    }
    turns.reverse();
    const parents = JSON.stringify([...new Set(turns.map((turn) => turn.parent))]),
      variantCounts = Object.fromEntries(
        this.data.catalog
          .prepare(
            "SELECT parent,count(*) AS n FROM entities WHERE kind='turn' AND conversation=? AND parent IN (SELECT value FROM json_each(?)) GROUP BY parent",
          )
          .all(conversation.id, parents)
          .map((row) => [String(row.parent), Number(row.n)]),
      );
    const jobs = turns
      .map((turn) => this.data.catalog.get<Job>('job', turn.job))
      .filter((job): job is Job => !!job)
      .map((job) => {
        try {
          return { ...this.jobs.read(user, job.id), settings: '' };
        } catch {
          return {
            ...job,
            status: 'interrupted' as const,
            result: {},
            error: 'ACCESS_REVOKED',
            settings: '',
          };
        }
      });
    const hasMore = !!cursor && !seen.has(cursor);
    return {
      conversation,
      turns,
      jobs,
      variantCounts,
      history: { before: hasMore ? turns[0]!.id : '', hasMore },
    };
  }
  async handleConversationsVariants(user: Principal, p: Input) {
    const conversation = this.access.owns(user, string(p, 'id')),
      parent = string(p, 'parent'),
      page = pagination(p),
      params = [conversation.id, parent],
      where = 'conversation=? AND parent=?';
    const items = this.data.catalog
      .prepare(
        "SELECT id,parent,substr(question,1,200) AS question,state AS status,created FROM entities WHERE kind='turn' AND conversation=? AND parent=? ORDER BY created,id LIMIT ? OFFSET ?",
      )
      .all(...params, page.pageSize, page.offset)
      .map((row) => ({
        id: String(row.id),
        parent: String(row.parent),
        question: String(row.question),
        status: String(row.status) as TurnVariant['status'],
        created: Number(row.created),
      }));
    return {
      items,
      total: this.data.catalog.count('turn', where, params),
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async handleConversationsSave(user: Principal, p: Input) {
    const c = this.access.owns(user, string(p, 'id'));
    revision(p, c);
    if (p.title !== undefined) c.title = string(p, 'title');
    if (p.draft !== undefined) c.draft = string(p, 'draft');
    if (p.selected !== undefined) {
      const id = string(p, 'selected');
      requireValue(
        !id || this.data.catalog.get<Turn>('turn', id)?.conversation === c.id,
        'INVALID_BRANCH',
        'Версия не принадлежит диалогу.',
      );
      c.selected = id;
    }
    c.revision++;
    c.updated = Date.now();
    this.data.catalog.put('conversation', c);
    return c;
  }

  async handleConversationsDelete(user: Principal, p: Input) {
    const c = this.access.owns(user, string(p, 'id'));
    revision(p, c);
    for (const job of this.data.catalog.find<Job>(
      'job',
      "conversation=? AND state IN ('queued','searching','generating')",
      [c.id],
    ))
      this.jobs.cancel(user, job.id);
    this.data.catalog.transaction(() => {
      for (const document of this.data.catalog.find<DocumentRecord>('document', 'conversation=?', [
        c.id,
      ]))
        this.documents.purge(document);
      this.data.catalog
        .prepare(
          "DELETE FROM entities WHERE kind='feedback' AND json_extract(body,'$.turn') IN (SELECT id FROM entities WHERE kind='turn' AND conversation=?)",
        )
        .run(c.id);
      this.data.catalog
        .prepare(
          "DELETE FROM events WHERE job IN (SELECT id FROM entities WHERE kind='job' AND conversation=?)",
        )
        .run(c.id);
      this.data.catalog
        .prepare("DELETE FROM entities WHERE kind IN ('turn','job') AND conversation=?")
        .run(c.id);
      this.data.catalog.delete('conversation', c.id);
      this.data.catalog.invalidate();
    });
    return { ok: true };
  }

  exportConversation(user: Principal, id: string) {
    this.access.owns(this.data.auth.current(user.id), id);
    const snapshot = this.data.catalog.readSnapshot();
    try {
      const row = snapshot.db
        .prepare("SELECT body FROM entities WHERE kind='conversation' AND id=? AND owner=?")
        .get(id, user.id);
      requireValue(row, 'NOT_FOUND', 'Диалог не найден.', 404);
      const conversation = JSON.parse(String(row.body)) as Conversation;
      const auth = this.data.auth,
        access = this.access;
      function* turns() {
        for (const row of snapshot.db
          .prepare(
            "SELECT body FROM entities WHERE kind='turn' AND conversation=? ORDER BY created,id",
          )
          .iterate(id)) {
          const current = auth.current(user.id);
          access.owns(current, id);
          yield access.turn(current, JSON.parse(String(row.body)) as Turn);
        }
      }
      return {
        conversation,
        turns: turns(),
        exported: new Date().toISOString(),
        close: () => snapshot.close(),
      };
    } catch (error) {
      snapshot.close();
      throw error;
    }
  }

  async handleAnswersCreate(user: Principal, p: Input) {
    return this.createAnswer(user, p);
  }
}
