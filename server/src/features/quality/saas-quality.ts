import { randomUUID } from 'node:crypto';
import type { Services } from '../../application/services.js';
import type { Documents } from '../documents/saas-documents.js';
import type { Search } from '../search/saas-search.js';
import type {
  Principal,
  CheckQuestion,
  EvaluationRecord,
  Feedback,
  Turn,
  Job,
} from '../../contracts/public.js';
import { requireValue, errorResponse } from '../../shared/errors.js';
import { string, strings, revision, number } from '../../shared/input.js';
import type { Input } from '../../shared/input.js';
export class Quality {
  constructor(
    readonly s: Services,
    readonly documents: Documents,
    readonly search: Search,
  ) {}
  async save(user: Principal, p: Input) {
    this.s.identity.admin(user);
    const id = string(p, 'id', randomUUID()),
      old = await this.s.db.get<CheckQuestion>('check_question', id);
    if (old) revision(p, old);
    const documents = strings(p, 'documents');
    for (const id of documents) await this.documents.document(user, id);
    const check: CheckQuestion = {
      id,
      revision: (old?.revision ?? 0) + 1,
      question: string(p, 'question', '', 32000),
      scope: await this.documents.scope(user, (p.scope ?? {}) as Input),
      documents,
      facts: strings(p, 'facts'),
      refuse: p.refuse === true,
    };
    requireValue(check.question.trim(), 'INVALID_INPUT', 'Question required.');
    return this.s.db.put('check_question', check);
  }
  async feedback(user: Principal, p: Input) {
    return this.s.db.transaction(async () => {
      await this.s.db.lock('access');
      user = await this.s.identity.current(user.id, user.tenant);
      const turn = await this.s.db.get<Turn>('turn', string(p, 'turn'));
      requireValue(turn, 'NOT_FOUND', 'Turn not found.', 404);
      await this.documents.conversation(user, turn.conversation);
      for (const source of turn.sources)
        requireValue(
          await this.documents.permittedSource(user, source),
          'FORBIDDEN',
          'Source access revoked.',
          403,
        );
      const rating = number(p, 'rating');
      requireValue(rating === -1 || rating === 1, 'INVALID_INPUT', 'Rating must be -1 or 1.');
      const result: Feedback = {
        id: randomUUID(),
        owner: user.id,
        turn: turn.id,
        rating,
        reason: string(p, 'reason'),
        detail: string(p, 'detail', '', 4000),
        created: Date.now(),
        sources: turn.sources,
        settings: (await this.s.db.get<Job>('job', turn.job))?.settings ?? '',
      };
      return this.s.db.put('feedback', result);
    });
  }
  async report(user: Principal, p: Input) {
    this.s.identity.admin(user);
    const page = Math.max(1, number(p, 'page', 1)),
      pageSize = Math.min(100, Math.max(1, number(p, 'pageSize', 25)));
    const feedback = await this.s.db.list<Feedback>(
      'feedback',
      'true',
      [],
      pageSize,
      (page - 1) * pageSize,
    );
    const visible = [];
    for (const f of feedback) {
      const turn = await this.s.db.get<Turn>('turn', f.turn);
      let authorized = true;
      for (const source of f.sources)
        if (!(await this.documents.permittedSource(user, source))) authorized = false;
      if (
        authorized &&
        turn &&
        (await this.documents.conversation(user, turn.conversation).then(
          () => true,
          () => false,
        ))
      )
        visible.push({ ...f, question: turn.question, answer: turn.answer });
    }
    return {
      feedback: visible,
      unanswered: await this.s.db.list<Turn>(
        'turn',
        "body->>'status'='no_info' AND conversation_id IN (SELECT id FROM conversations WHERE tenant_id=$1 AND owner_id=$2)",
        [user.id],
        pageSize,
        (page - 1) * pageSize,
      ),
      checks: await this.s.db.list<CheckQuestion>(
        'check_question',
        'true',
        [],
        pageSize,
        (page - 1) * pageSize,
      ),
      runs: await this.s.db.list<Job>(
        'job',
        "body->>'kind'='evaluation'",
        [],
        pageSize,
        (page - 1) * pageSize,
      ),
      totals: {
        feedback: await this.s.db.count('feedback'),
        unanswered: await this.s.db.count('turn', "body->>'status'='no_info'"),
        checks: await this.s.db.count('check_question'),
        runs: await this.s.db.count('job', "body->>'kind'='evaluation'"),
      },
      page,
      pageSize,
    };
  }
  async process(job: Job, user: Principal, signal: AbortSignal, attempt: string) {
    const checks = await this.s.db.list<CheckQuestion>('check_question', 'true', [], 10000),
      settings = await this.s.identity.settings(),
      model = await this.s.ai.profile(settings.generationProfile, 'generation');
    for (const check of checks) {
      signal.throwIfAborted();
      const existing = await this.s.db.list<EvaluationRecord>(
        'evaluation',
        "body->>'job'=$2 AND body->>'check'=$3",
        [job.id, check.id],
        1,
      );
      if (existing.length) continue;
      const start = Date.now();
      let answer = '';
      const result: EvaluationRecord = {
        id: randomUUID(),
        job: job.id,
        created: Date.now(),
        settings: job.settings,
        check: check.id,
        question: check.question,
        sourceRetrieval: false,
        answerFacts: false,
        citationsValid: false,
        refusalCorrect: false,
        milliseconds: 0,
        answer: '',
        sources: [],
        assessment: 'Literal fact and citation checks; not an expert safety assessment.',
        expected: { documents: check.documents, facts: check.facts, refuse: check.refuse },
      };
      try {
        await this.s.queue.update(
          job.id,
          { status: 'searching', result: { check: check.id } },
          attempt,
        );
        result.sources = await this.search.search(
          user,
          check.question,
          check.scope,
          undefined,
          job.id,
          signal,
        );
        if (result.sources.length)
          await this.s.ai.generate(
            model,
            {
              system: settings.prompt,
              question: [{ kind: 'text', text: check.question }],
              history: [],
              context: result.sources.map((s) => ({
                kind: 'text' as const,
                text: `[${s.id}] ${s.text}`,
              })),
            },
            job.id,
            signal,
            (t) => {
              answer += t;
              requireValue(answer.length <= 262144, 'ANSWER_LIMIT', 'Answer too large.');
            },
          );
        else answer = '[NO_INFO]';
        result.answer = answer;
        result.sourceRetrieval = check.documents.every((id) =>
          result.sources.some((s) => s.document === id),
        );
        result.answerFacts = check.facts.every((f) =>
          answer.toLowerCase().includes(f.toLowerCase()),
        );
        result.citationsValid = [...answer.matchAll(/\[(\d+)\]/gu)].every((m) =>
          result.sources.some((s) => s.id === Number(m[1])),
        );
        result.refusalCorrect = answer.includes('[NO_INFO]') === check.refuse;
      } catch (e) {
        result.error = errorResponse(e).error;
      }
      result.milliseconds = Date.now() - start;
      await this.s.db.transaction(async () => {
        await this.s.db.lock('access');
        const current = await this.s.identity.current(user.id, user.tenant);
        let authorized = Boolean(await this.s.db.get('check_question', check.id));
        for (const source of result.sources)
          if (!(await this.documents.permittedSource(current, source))) authorized = false;
        if (!authorized) {
          result.answer = 'Access revoked';
          result.sources = [];
          result.expected = { documents: [], facts: [], refuse: false };
          result.redacted = true;
        }
        await this.s.queue.update(
          job.id,
          { status: 'indexing', result: { check: check.id } },
          attempt,
        );
        await this.s.db.put('evaluation', result);
      });
    }
    await this.s.queue.update(
      job.id,
      { status: 'complete', result: { checks: checks.length } },
      attempt,
    );
  }
}
