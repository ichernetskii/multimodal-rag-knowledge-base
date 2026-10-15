import { randomUUID } from 'node:crypto';
import { authorized, type ActionMap } from '../../application/action-registry.js';
import type { DataContext } from '../../application/data-context.js';
import type {
  CheckQuestion,
  Feedback,
  Job,
  Principal,
  Turn,
  EvaluationRecord,
  Source,
} from '../../domain/entities.js';
import { errorResponse, requireValue } from '../../shared/errors.js';
import type { Input } from '../../shared/input.js';
import { localized, number, object, revision, scope, string, strings } from '../../shared/input.js';
import { pagination } from '../../shared/pagination.js';
import type { AccessPolicy } from '../identity/access-policy.js';
import type { JobService } from '../jobs/job-service.js';
import type { SearchService } from '../search/search-service.js';
export class QualityService {
  constructor(
    private readonly data: DataContext,
    private readonly jobs: JobService,
    private readonly search: SearchService,
    private readonly access: AccessPolicy,
  ) {}
  readonly actions: ActionMap = {
    'feedback.create': authorized((user, p) => this.handleFeedbackCreate(user, p)),
    'quality.list': authorized((user, p) => this.handleQualityList(user, p)),
    'quality.results': authorized((user, p) => this.handleQualityResults(user, p)),
    'quality.delete': authorized((user, p) => this.handleQualityDelete(user, p)),
    'quality.save': authorized((user, p) => this.handleQualitySave(user, p)),
    'quality.run': authorized((user) => this.handleQualityRun(user)),
  };
  async process(job: Job, user: Principal, signal: AbortSignal) {
    this.data.auth.admin(user);
    const checks = this.data.catalog.list<CheckQuestion>('check');
    this.jobs.update(job, {
      status: 'searching',
      result: { total: checks.length, processed: 0, passed: 0, failed: 0 },
    });
    let passed = 0,
      failed = 0;
    for (const check of checks) {
      signal.throwIfAborted();
      this.data.auth.admin(this.data.auth.current(user.id));
      const started = Date.now();
      let sources: Source[] = [],
        answer = localized(
          check.question,
          'В документах недостаточно информации.',
          'The documents do not contain enough information.',
        ),
        insufficient = true,
        error: EvaluationRecord['error'];
      let settings = this.data.catalog.settings();
      try {
        this.jobs.update(job, { status: 'searching' });
        sources = await this.search.search(user, check.question, check.scope);
        settings = this.data.catalog.settings();
        if (sources.length) {
          this.jobs.update(job, { status: 'generating' });
          const reply = await this.data.models.generate(
            check.question,
            sources,
            [],
            settings,
            signal,
            () => {
              signal.throwIfAborted();
              const current = this.data.auth.current(user.id);
              this.data.auth.admin(current);
              requireValue(
                sources.every((source) => this.access.source(current, source)),
                'ACCESS_REVOKED',
                'Доступ к источникам отозван.',
                403,
              );
            },
          );
          answer = reply.answer;
          insufficient = reply.insufficient;
        }
      } catch (cause) {
        signal.throwIfAborted();
        error = errorResponse(cause).error;
        answer = error.message;
        this.data.catalog.log(error.code, error.diagnostic);
      }
      signal.throwIfAborted();
      this.data.auth.admin(this.data.auth.current(user.id));
      const citations = [...answer.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1]));
      const result: EvaluationRecord = {
        id: randomUUID(),
        job: job.id,
        created: Date.now(),
        check: check.id,
        question: check.question,
        sourceRetrieval:
          !error && check.documents.every((id) => sources.some((source) => source.document === id)),
        answerFacts:
          !error && check.facts.every((fact) => answer.toLowerCase().includes(fact.toLowerCase())),
        citationsValid:
          !error &&
          citations.every((id) => sources.some((source) => source.id === id)) &&
          (insufficient || citations.length > 0),
        refusalCorrect: !error && (check.refuse ? insufficient : !insufficient),
        milliseconds: Date.now() - started,
        answer,
        sources,
        assessment: 'Совпадение ожидаемых ключевых фраз; ответ доступен для проверки человеком.',
        settings: JSON.stringify({ settings, runtime: this.data.models.configuration?.() ?? {} }),
        expected: { documents: check.documents, facts: check.facts, refuse: check.refuse },
        ...(error ? { error } : {}),
      };
      if (
        result.sourceRetrieval &&
        result.answerFacts &&
        result.citationsValid &&
        result.refusalCorrect
      )
        passed++;
      else failed++;
      this.data.catalog.transaction(() => {
        this.data.catalog.put('evaluation_result', result);
        this.jobs.update(job, {
          result: { total: checks.length, processed: passed + failed, passed, failed },
        });
      });
    }
    this.jobs.update(job, {
      status: 'complete',
      result: { total: checks.length, processed: passed + failed, passed, failed },
    });
  }
  async handleFeedbackCreate(user: Principal, p: Input) {
    const t = this.data.catalog.get<Turn>('turn', string(p, 'turn'));
    requireValue(t, 'NOT_FOUND', 'Ответ не найден.', 404);
    this.access.owns(user, t.conversation);
    requireValue(
      ['wrong_source', 'outdated', 'no_answer', 'irrelevant_answer', 'other'].includes(
        string(p, 'reason'),
      ),
      'INVALID_INPUT',
      'Некорректная причина.',
    );
    const rating = number(p, 'rating');
    requireValue([-1, 1].includes(rating), 'INVALID_INPUT', 'Оценка должна быть -1 или 1.');
    const f: Feedback = {
      id: randomUUID(),
      owner: user.id,
      turn: t.id,
      rating,
      reason: string(p, 'reason'),
      detail: string(p, 'detail'),
      created: Date.now(),
      sources: t.sources,
      settings: this.data.catalog.get<Job>('job', t.job)?.settings ?? '',
    };
    this.data.catalog.put('feedback', f);
    return f;
  }
  async handleQualityList(user: Principal, p: Input) {
    this.data.auth.admin(user);
    const page = pagination(p);
    return {
      page: page.page,
      pageSize: page.pageSize,
      totals: {
        feedback: this.data.catalog.count('feedback'),
        unanswered: this.data.catalog.count(
          'turn',
          "state IN ('no_info','failed','clarification')",
        ),
        checks: this.data.catalog.count('check'),
        runs: this.data.catalog.count('job', "job_kind='evaluation'"),
      },
      feedback: this.data.catalog
        .find<Feedback>('feedback', '1', [], 'created DESC', page.pageSize, page.offset)
        .map((f) => {
          const turn = this.data.catalog.get<Turn>('turn', f.turn);
          const visible = turn ? this.access.turn(user, turn) : undefined;
          return {
            ...f,
            sources: f.sources.filter((source) => this.access.source(user, source)),
            question:
              visible && 'redacted' in visible && visible.redacted
                ? 'Вопрос по недоступным источникам.'
                : (turn?.question ?? ''),
            answer: visible?.answer ?? '',
          };
        }),
      unanswered: this.data.catalog
        .find<Turn>(
          'turn',
          "state IN ('no_info','failed','clarification')",
          [],
          'created DESC',
          page.pageSize,
          page.offset,
        )
        .map((turn) => {
          const visible = this.access.turn(user, turn);
          return 'redacted' in visible && visible.redacted
            ? { ...visible, question: 'Вопрос по недоступным источникам.' }
            : visible;
        }),
      checks: this.data.catalog.find<CheckQuestion>(
        'check',
        '1',
        [],
        'id',
        page.pageSize,
        page.offset,
      ),
      runs: this.data.catalog.find<Job>(
        'job',
        "job_kind='evaluation'",
        [],
        'created DESC',
        page.pageSize,
        page.offset,
      ),
    };
  }
  async handleQualityResults(user: Principal, p: Input) {
    this.data.auth.admin(user);
    const job = this.data.catalog.get<Job>('job', string(p, 'job'));
    requireValue(job?.kind === 'evaluation', 'NOT_FOUND', 'Проверка не найдена.', 404);
    const page = pagination(p),
      where = "json_extract(body,'$.job')=?",
      params = [job.id];
    return {
      items: this.data.catalog
        .find<EvaluationRecord>(
          'evaluation_result',
          where,
          params,
          'created,id',
          page.pageSize,
          page.offset,
        )
        .map((result) =>
          result.sources.every((source) => this.access.source(user, source))
            ? result
            : {
                ...result,
                question: 'Вопрос по недоступным источникам.',
                answer: 'Доступ к источникам отозван.',
                sources: [],
                expected: { documents: [], facts: [], refuse: result.expected.refuse },
                redacted: true,
              },
        ),
      total: this.data.catalog.count('evaluation_result', where, params),
      page: page.page,
      pageSize: page.pageSize,
    };
  }
  async handleQualitySave(user: Principal, p: Input) {
    this.data.auth.admin(user);
    const id = string(p, 'id', randomUUID()),
      old = this.data.catalog.get<CheckQuestion>('check', id);
    if (old) revision(p, old);
    else
      requireValue(
        this.data.catalog.count('check') < 1000,
        'CHECK_LIMIT',
        'Допускается до 1000 контрольных вопросов.',
      );
    const question: CheckQuestion = {
      id,
      revision: (old?.revision ?? 0) + 1,
      question: string(p, 'question'),
      scope: scope(object(p, 'scope')),
      documents: strings(p, 'documents'),
      facts: strings(p, 'facts'),
      refuse: p.refuse === true,
    };
    requireValue(
      question.question.trim() &&
        question.question.length <= 5000 &&
        (question.refuse || (question.documents.length && question.facts.length)),
      'INVALID_INPUT',
      'Укажите вопрос, ожидаемые источники и факты либо ожидание отказа.',
    );
    requireValue(
      !question.scope.conversation,
      'QUALITY_SCOPE',
      'Контрольный набор предназначен для общих баз знаний. Личные вложения проверяйте в своём диалоге.',
    );
    question.documents.forEach((id) => {
      const document = this.data.auth.document(user, id);
      requireValue(
        !document.conversation,
        'QUALITY_SCOPE',
        'Личные вложения не включаются в общий набор контрольных вопросов.',
      );
    });
    this.data.catalog.put('check', question);
    return question;
  }
  async handleQualityDelete(user: Principal, p: Input) {
    this.data.auth.admin(user);
    const old = this.data.catalog.get<CheckQuestion>('check', string(p, 'id'));
    requireValue(old, 'NOT_FOUND', 'Вопрос не найден.', 404);
    revision(p, old);
    this.data.catalog.delete('check', old.id);
    return { ok: true };
  }
  async handleQualityRun(user: Principal) {
    this.data.auth.admin(user);
    requireValue(
      this.data.catalog.count('check'),
      'NO_CHECKS',
      'Сначала добавьте контрольные вопросы.',
    );
    const job = this.jobs.create(user, 'evaluation', {});
    this.jobs.update(job, {
      result: { total: this.data.catalog.count('check'), processed: 0, passed: 0, failed: 0 },
    });
    return job;
  }
}
