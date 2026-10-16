import { randomUUID, createHash } from 'node:crypto';
import type { Services } from '../../application/services.js';
import type { Documents } from '../documents/saas-documents.js';
import type { Search } from '../search/saas-search.js';
import type {
  Principal,
  Conversation,
  Turn,
  Job,
  Source,
  ModelProfile,
  Settings,
} from '../../contracts/public.js';
import type { StoredVersion } from '../../domain/entities.js';
import type { Input } from '../../shared/input.js';
import { string, number, strings, revision } from '../../shared/input.js';
import { requireValue } from '../../shared/errors.js';
import { signature, estimateInput } from '../models/ai-service.js';
import type { AIInput } from '../../application/ports/ai.js';
export class Chat {
  constructor(
    readonly s: Services,
    readonly documents: Documents,
    readonly search: Search,
  ) {}
  async owns(user: Principal, id: string) {
    const c = await this.s.db.get<Conversation>('conversation', id);
    requireValue(c?.owner === user.id, 'NOT_FOUND', 'Conversation not found.', 404);
    return c;
  }
  async guard(user: Principal, turn: Turn) {
    for (const source of [...turn.sources, ...(turn.accessSources ?? [])])
      if (!(await this.documents.permittedSource(user, source)))
        return {
          ...turn,
          answer: 'Доступ к источникам этого ответа отозван.',
          sources: [],
          accessSources: [],
          redacted: true,
        };
    return turn;
  }
  async create(user: Principal, p: Input) {
    const title = string(p, 'title', 'Новый диалог', 200);
    return this.s.db.put('conversation', {
      id: randomUUID(),
      owner: user.id,
      title,
      draft: '',
      selected: '',
      revision: 1,
      updated: Date.now(),
    });
  }
  async read(user: Principal, p: Input) {
    const conversation = await this.owns(user, string(p, 'id')),
      pageSize = Math.min(100, Math.max(1, number(p, 'pageSize', 40)));
    let id = string(p, 'before', conversation.selected);
    const turns: Turn[] = [];
    if (p.before) {
      const before = await this.s.db.get<Turn>('turn', id);
      requireValue(
        before?.conversation === conversation.id,
        'NOT_FOUND',
        'History cursor not found.',
        404,
      );
      id = before.parent;
    }
    while (id && turns.length < pageSize) {
      const turn = await this.s.db.get<Turn>('turn', id);
      if (!turn || turn.conversation !== conversation.id) break;
      turns.unshift(await this.guard(user, turn));
      id = turn.parent;
    }
    const jobs = await this.s.db.list<Job>(
      'job',
      "body->>'owner'=$2 AND body->'payload'->>'conversation'=$3 AND body->>'status' NOT IN('complete','no_info','clarification','cancelled','failed','interrupted')",
      [user.id, conversation.id],
      100,
    );
    const counts = await this.s.db.query<{ parent: string; count: string }>(
      "SELECT body->>'parent' parent,count(*) count FROM turns WHERE tenant_id=$1 AND conversation_id=$2 GROUP BY body->>'parent'",
      [user.tenant, conversation.id],
    );
    return {
      conversation,
      turns,
      jobs,
      history: { before: turns[0]?.id ?? '', hasMore: Boolean(id) },
      variantCounts: Object.fromEntries(counts.map((v) => [v.parent, Number(v.count)])),
    };
  }
  async answer(user: Principal, p: Input) {
    const question = string(p, 'question', '', 32000),
      key = string(p, 'idempotencyKey', '', 200);
    requireValue(
      question.trim() && key.length >= 8,
      'INVALID_INPUT',
      'Question and idempotency key are required.',
    );
    const attachments = strings(p, 'attachments');
    requireValue(attachments.length <= 3, 'ATTACHMENT_LIMIT', 'Select up to three attachments.');
    const selection = await this.documents.scope(user, (p.scope ?? {}) as Input);
    const settings = await this.s.identity.settings(),
      model = await this.s.ai.profile(
        string(p, 'profile', settings.generationProfile),
        'generation',
      );
    return this.s.db.transaction(async () => {
      await this.s.db.lock('answer');
      const requestHash = signature(p);
      const [old] = await this.s.db.query<{ request_hash: string; result: unknown }>(
        'SELECT * FROM idempotency WHERE tenant_id=$1 AND key=$2',
        [user.tenant, user.id + ':' + key],
      );
      if (old) {
        requireValue(
          old.request_hash === requestHash,
          'IDEMPOTENCY_CONFLICT',
          'Key was already used for a different request.',
          409,
        );
        return old.result;
      }
      const conversation = await this.owns(user, string(p, 'conversation'));
      revision(p, conversation);
      for (const id of attachments) {
        const d = await this.documents.document(user, id);
        requireValue(
          d.conversation === conversation.id && d.state === 'published',
          'INVALID_ATTACHMENT',
          'Attachment is not ready or belongs to another conversation.',
        );
      }
      let parent = conversation.selected;
      const replaces = string(p, 'replaces');
      if (replaces) {
        const oldTurn = await this.s.db.get<Turn>('turn', replaces);
        requireValue(
          oldTurn?.conversation === conversation.id,
          'NOT_FOUND',
          'Turn not found.',
          404,
        );
        parent = oldTurn.parent;
      }
      const turn: Turn = {
        id: randomUUID(),
        conversation: conversation.id,
        parent,
        replaces,
        question,
        attachments,
        answer: '',
        sources: [],
        status: 'queued',
        job: '',
        created: Date.now(),
        scope: selection,
      };
      const job = await this.s.queue.create(
        'answer',
        { conversation: conversation.id, turn: turn.id, model },
        user,
      );
      turn.job = job.id;
      conversation.selected = turn.id;
      conversation.draft = '';
      conversation.revision++;
      conversation.updated = Date.now();
      await this.s.db.put('turn', turn);
      await this.s.db.put('conversation', conversation);
      const result = { conversation, turn, job };
      await this.s.db.query('INSERT INTO idempotency VALUES($1,$2,$3,$4,$5)', [
        user.tenant,
        user.id + ':' + key,
        requestHash,
        JSON.stringify(result),
        Date.now(),
      ]);
      return result;
    });
  }
  async process(job: Job, user: Principal, signal: AbortSignal, attempt: string) {
    const turn = await this.s.db.get<Turn>('turn', String(job.payload.turn));
    requireValue(turn, 'SOURCE_DELETED', 'Turn was deleted.', 409);
    await this.owns(user, turn.conversation);
    const settings = JSON.parse(job.settings) as Settings,
      model = job.payload.model as ModelProfile;
    requireValue(
      model && model.role === 'generation',
      'INVALID_PROFILE',
      'Missing generation profile snapshot.',
    );
    await this.s.ai.profile(model.id, 'generation');
    const attachments: Source[] = [],
      queryParts: AIInput[] = [{ kind: 'text', text: turn.question }];
    for (const id of turn.attachments ?? []) {
      const detail = await this.documents.details(user, id);
      requireValue(
        detail.document.conversation === turn.conversation && detail.document.state === 'published',
        'INVALID_ATTACHMENT',
        'Attachment is no longer available.',
      );
      const stored = await this.s.db.get<StoredVersion>('version', detail.version.id);
      requireValue(stored, 'NOT_FOUND', 'Version not found.');
      for (const page of stored.pages.slice(0, 1)) {
        const source: Source = {
          id: 0,
          chunk:
            (
              await this.s.db.query<{ id: string }>(
                "SELECT id FROM source_fragments WHERE tenant_id=$1 AND version_id=$2 AND (body->>'page')::int=$3 ORDER BY id LIMIT 1",
                [user.tenant, stored.id, page.number],
              )
            )[0]?.id ?? '',
          document: id,
          version: stored.id,
          name: stored.name,
          page: page.number,
          section: page.sections[0]?.title ?? '',
          text: page.text,
          ...(page.media ? { media: page.media } : {}),
        };
        attachments.push(source);
        if (queryParts.length < 2 && page.media) {
          const input = await this.documents.mediaInput(user, detail.document, stored, page);
          const index = await this.documents.activeIndex();
          for (const part of input)
            if (part.kind !== 'text' && index.model.input.includes(part.kind))
              queryParts.push(part);
        }
      }
    }
    await this.s.queue.update(job.id, { status: 'searching' }, attempt);
    const retrieved = await this.search.search(
      user,
      turn.question,
      { ...turn.scope, conversation: turn.conversation },
      queryParts,
      job.id,
      signal,
    );
    turn.sources = [
      ...attachments,
      ...retrieved.filter(
        (s) => !attachments.some((a) => a.document === s.document && a.page === s.page),
      ),
    ]
      .slice(0, settings.topK + 3)
      .map((s, i) => ({ ...s, id: i + 1 }));
    const history: { role: 'user' | 'assistant'; content: string }[] = [],
      dependencies: Pick<Source, 'document' | 'version' | 'chunk'>[] = [];
    let parent = turn.parent;
    for (let n = 0; parent && n < 20; n++) {
      const prior = await this.s.db.get<Turn>('turn', parent);
      if (!prior || prior.conversation !== turn.conversation) break;
      const guarded = await this.guard(user, prior);
      if (!('redacted' in guarded) && prior.answer) {
        history.unshift({ role: 'assistant', content: prior.answer });
        history.unshift({ role: 'user', content: prior.question });
        dependencies.push(...prior.sources, ...(prior.accessSources ?? []));
      }
      parent = prior.parent;
    }
    turn.accessSources = dependencies;
    let mediaSelected = 0;
    turn.sources = turn.sources
      .filter((source) => !source.media || mediaSelected++ < settings.answerMaxImages)
      .map((source, i) => ({ ...source, id: i + 1 }));
    const context: AIInput[] = [];
    let mediaCount = 0;
    for (const source of turn.sources) {
      context.push({
        kind: 'text',
        text: `[${source.id}] ${source.name}, page ${source.page}\n${source.text}`,
      });
      if (source.media?.asset) {
        const kind = model.input.includes(source.media.kind)
          ? source.media.kind
          : source.media.preview && model.input.includes('image')
            ? 'image'
            : undefined;
        if (kind && mediaCount < settings.answerMaxImages) {
          const asset = await this.documents.asset(
            user,
            source.document,
            source.version,
            kind === 'image' && source.media.kind === 'video'
              ? source.media.preview
              : source.media.asset,
          );
          context.push({
            kind,
            bytes: await this.s.storage.bytes(asset.object_key, model.maxBytes, signal),
            mime: asset.mime,
            seconds:
              kind === 'image'
                ? 0
                : Math.max(0, (source.media.endMs ?? 0) - (source.media.startMs ?? 0)) / 1000,
          });
          mediaCount++;
        } else if (!kind) {
          const version = await this.s.db.get<StoredVersion>('version', source.version);
          const page = version?.pages.find((p) => p.number === source.page);
          requireValue(
            page &&
              (page.method === 'text' ||
                page.method === 'ocr' ||
                page.sections.some((s) => ['Transcript', 'Visual description'].includes(s.title))),
            'UNSUPPORTED_MODALITY',
            `${model.name} cannot read ${source.media.kind}. Choose a matching profile or an explicitly prepared transcript/description.`,
          );
        }
      }
    }
    const budget =
      Math.min(model.contextTokens, settings.contextTokens) -
      Math.min(model.maxOutputTokens, settings.maxOutputTokens);
    const contextCost = () =>
      estimateInput([
        ...context,
        {
          kind: 'text',
          text: settings.prompt + turn.question + history.map((m) => m.content).join('\n'),
        },
      ]);
    while (history.length && contextCost() > budget) history.splice(0, 2);
    while (turn.sources.length > 1 && contextCost() > budget) {
      const last = turn.sources.pop()!;
      const at = context.findIndex(
        (part) => part.kind === 'text' && part.text?.startsWith('[' + last.id + '] '),
      );
      if (at >= 0) context.splice(at);
    }
    requireValue(
      contextCost() <= budget,
      'CONTEXT_LIMIT',
      'Question or selected source exceeds the configured context budget. Choose a larger context profile.',
    );
    const authorize = async () => {
      signal.throwIfAborted();
      const current = await this.s.identity.current(user.id, user.tenant);
      await this.owns(current, turn.conversation);
      for (const source of [...turn.sources, ...dependencies])
        requireValue(
          await this.documents.permittedSource(current, source),
          'SOURCE_ACCESS_REVOKED',
          'Source access was revoked.',
          403,
        );
    };
    const persist = async (status: Turn['status']) => {
      await authorize();
      await this.s.db.transaction(async () => {
        await this.s.db.lock('access');
        await authorize();
        await this.s.queue.update(job.id, { status }, attempt);
        requireValue(
          await this.s.db.get('turn', turn.id),
          'SOURCE_DELETED',
          'Turn was deleted.',
          409,
        );
        turn.status = status;
        await this.s.db.put('turn', turn);
      });
    };
    if (!turn.sources.length) {
      turn.answer = /[а-яё]/iu.test(turn.question)
        ? 'В доступной базе знаний не найдено достаточно информации.'
        : 'No sufficient information was found in the authorized knowledge base.';
      await persist('no_info');
      return;
    }
    const [revisions] = await this.s.db.query(
      'SELECT content_revision,access_revision FROM tenants WHERE id=$1',
      [user.tenant],
    );
    const cacheKey =
      user.tenant +
      ':answer:' +
      signature({
        revisions,
        question: turn.question,
        context: context.map((p) => ({
          ...p,
          bytes: p.bytes ? createHash('sha256').update(p.bytes).digest('hex') : undefined,
        })),
        history,
        model,
        prompt: settings.prompt,
        user: user.id,
        sources: turn.sources,
        dependencies,
      });
    await persist('generating');
    const cached = model.cache ? await this.s.cache.get<{ answer: string }>(cacheKey) : undefined;
    if (cached) {
      await this.s.queue.update(job.id, { result: { cache: 'exact-answer-hit' } }, attempt);
      turn.answer = cached.answer;
      await persist(turn.answer.includes('[NO_INFO]') ? 'no_info' : 'complete');
      return;
    }
    let last = 0,
      writing = Promise.resolve();
    const schedule = () => {
      if (Date.now() - last < 100) return;
      last = Date.now();
      const partial = turn.answer;
      writing = writing.then(async () => {
        await authorize();
        await this.s.db.transaction(async () => {
          await this.s.db.lock('access');
          await authorize();
          await this.s.queue.update(job.id, { status: 'generating' }, attempt);
          const current = await this.s.db.get<Turn>('turn', turn.id);
          requireValue(current, 'SOURCE_DELETED', 'Turn deleted.', 409);
          await this.s.db.put('turn', { ...turn, answer: partial, status: 'generating' });
        });
      });
      void writing.catch(() => {});
    };
    writing.catch(() => {});
    try {
      await this.s.ai.generate(
        {
          ...model,
          contextTokens: Math.min(model.contextTokens, settings.contextTokens),
          maxOutputTokens: Math.min(model.maxOutputTokens, settings.maxOutputTokens),
        },
        {
          system: settings.prompt,
          question: [{ kind: 'text', text: turn.question }],
          context,
          history,
        },
        job.id,
        signal,
        (text) => {
          turn.answer += text;
          requireValue(
            turn.answer.length <= 262144,
            'ANSWER_LIMIT',
            'Generated answer is too large.',
          );
          schedule();
        },
      );
      await writing;
      requireValue(turn.answer.trim(), 'EMPTY_ANSWER', 'Model returned an empty answer.', 502);
      const cited = [...turn.answer.matchAll(/\[(\d+)\]/gu)].map((v) => Number(v[1]));
      requireValue(
        cited.every((id) => turn.sources.some((s) => s.id === id)),
        'INVALID_CITATIONS',
        'Model returned an unknown source reference.',
        502,
      );
      await persist(turn.answer.includes('[NO_INFO]') ? 'no_info' : 'complete');
      if (model.cache)
        await this.s.cache.put(cacheKey, { answer: turn.answer }, settings.cacheSeconds);
    } catch (e) {
      await writing.catch(() => {});
      throw e;
    }
  }
}
