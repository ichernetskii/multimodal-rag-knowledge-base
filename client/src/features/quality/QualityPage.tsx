import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { api } from '../../shared/api/client';
import type { CheckQuestion } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { text } from '../../shared/lib/form-data';
import { date, quantity } from '../../shared/lib/format';
import { useLoad, useModal, usePolling } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Check, Field, Form, Select } from '../../shared/ui/Form';
import { Badge, EmptyState, Loading, PageHeader } from '../../shared/ui/Feedback';
import { Table, Pagination } from '../../shared/ui/DataTable';
import { DocumentPicker } from '../documents/DocumentPicker';
import { Source } from '../documents/SourceDialog';
import { RunCard } from './RunCard';
import { statuses } from '../jobs/job-status';
const reasons = {
  wrong_source: 'Неверный источник',
  outdated: 'Устаревшая информация',
  no_answer: 'Нет ответа',
  irrelevant_answer: 'Неподходящий ответ',
  other: 'Другая причина',
} as const;
const tabs = {
  feedback: 'Обратная связь',
  unanswered: 'Без ответа',
  checks: 'Контрольные вопросы',
  runs: 'Результаты проверок',
} as const;
function CheckEditor({ check, done }: { check?: CheckQuestion; done: () => void }) {
  const app = useApplication(),
    [documents, setDocuments] = useState(check?.documents ?? []);
  return (
    <>
      <p className="eyebrow">КОНТРОЛЬ КАЧЕСТВА</p>
      <h2>{check ? 'Изменить контрольный вопрос' : 'Новый контрольный вопрос'}</h2>
      <Form
        submit={async (f) => {
          await api('quality.save', {
            ...(check ? { id: check.id, revision: check.revision } : {}),
            question: text(f, 'question'),
            documents,
            facts: text(f, 'facts')
              .split('\n')
              .map((f) => f.trim())
              .filter(Boolean),
            refuse: f.has('refuse'),
            scope: { collection: text(f, 'collection') },
          });
          done();
        }}
      >
        <Field label="Вопрос" name="question" type="textarea" value={check?.question} required />
        <Select
          label="База знаний"
          name="collection"
          value={check?.scope.collection ?? ''}
          options={[
            ['', 'Все доступные'],
            ...app.bases.items.map((c) => [c.id, c.name] as [string, string]),
          ]}
        />
        <DocumentPicker selected={documents} onChange={setDocuments} />
        <Field
          label="Ожидаемые ключевые факты"
          name="facts"
          type="textarea"
          value={check?.facts.join('\n')}
          hint="По одному факту на строку. Проверка ищет эти фразы в ответе без учёта регистра."
        />
        <Check
          label="Ожидается отказ при отсутствии информации"
          name="refuse"
          checked={check?.refuse}
          hint="Для такого вопроса источники и ключевые факты необязательны."
        />
      </Form>
    </>
  );
}
export const Quality = observer(function Quality() {
  const app = useApplication(),
    modal = useModal(),
    [tab, setTab] = useState<keyof typeof tabs>('feedback'),
    [page, setPage] = useState(1);
  const load = useLoad((signal) => api('quality.list', { page, pageSize: 20 }, { signal }), [page]);
  usePolling(load.reload, 10000);
  const d = load.data;
  const edit = (check?: CheckQuestion) =>
    modal(
      <CheckEditor
        check={check}
        done={() => {
          modal(null);
          load.reload();
          app.notify('Контрольный вопрос сохранён.');
        }}
      />,
    );
  return (
    <>
      <PageHeader
        eyebrow="ПРОВЕРКА ОТВЕТОВ"
        title="Качество"
        description="Разбирайте обратную связь и проверяйте ответы после изменения модели, поиска или документов."
        actions={
          <>
            <Button onClick={() => edit()}>+ Контрольный вопрос</Button>
            <Button
              className="primary"
              disabled={!d?.totals.checks}
              onClick={async () => {
                const job = await api('quality.run');
                app.jobs.upsert(job);
                app.jobs.watch(job);
                setTab('runs');
                setPage(1);
                load.reload();
                app.notify('Проверка добавлена в очередь.');
              }}
            >
              Запустить проверку
            </Button>
          </>
        }
      />
      <div className="tabs" role="tablist" aria-label="Контроль качества">
        {(Object.keys(tabs) as (keyof typeof tabs)[]).map((key) => (
          <button
            key={key}
            id={'tab-' + key}
            role="tab"
            aria-selected={tab === key}
            aria-controls={'panel-' + key}
            tabIndex={tab === key ? 0 : -1}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const keys = Object.keys(tabs) as (keyof typeof tabs)[],
                  next =
                    keys[
                      (keys.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : keys.length - 1)) %
                        keys.length
                    ]!;
                setTab(next);
                setPage(1);
                document.getElementById('tab-' + next)?.focus();
              }
            }}
            onClick={() => {
              setTab(key);
              setPage(1);
            }}
          >
            {tabs[key]}
            <span>{d?.totals[key] ?? 0}</span>
          </button>
        ))}
      </div>
      {load.error && <Loading error={load.error} retry={load.reload} />}
      <div
        role="tabpanel"
        id={'panel-' + tab}
        aria-labelledby={'tab-' + tab}
        aria-busy={load.loading}
      >
        {!d ? (
          <Loading />
        ) : !d[tab].length ? (
          <section className="panel">
            <EmptyState
              title={
                tab === 'feedback'
                  ? 'Здесь появится обратная связь'
                  : tab === 'unanswered'
                    ? 'Неотвеченных вопросов пока нет'
                    : tab === 'checks'
                      ? 'Добавьте контрольные вопросы'
                      : 'Проверки ещё не запускались'
              }
              description={
                tab === 'feedback'
                  ? 'Пользователи могут оценить ответ и указать причину ошибки.'
                  : tab === 'unanswered'
                    ? 'Отказы, уточнения и технические ошибки сохраняются для разбора.'
                    : tab === 'checks'
                      ? 'Задайте ожидаемые источники и факты, чтобы сравнивать результаты изменений.'
                      : 'Создайте контрольные вопросы и запустите проверку.'
              }
            />
          </section>
        ) : (
          <>
            {tab === 'feedback' &&
              d.feedback.map((f) => (
                <section className="panel feedback-card" key={f.id}>
                  <div className="section-heading">
                    <Badge tone={f.rating < 0 ? 'warning' : 'success'}>
                      {reasons[f.reason as keyof typeof reasons] ?? f.reason}
                    </Badge>
                    <small>{date(f.created)}</small>
                  </div>
                  <h2>{f.question}</h2>
                  <p className="feedback-answer">{f.answer}</p>
                  {f.detail && <div className="quote">{f.detail}</div>}
                  <div className="source-chips">
                    {f.sources.map((source) => (
                      <Button key={source.chunk} onClick={() => modal(<Source source={source} />)}>
                        {source.name} · стр. {source.page}
                      </Button>
                    ))}
                  </div>
                  <details>
                    <summary>Настройки и версии источников</summary>
                    <p>{f.sources.map((s) => s.name + ' · ' + s.version.slice(0, 8)).join(', ')}</p>
                    <pre className="json-view">
                      {f.settings
                        ? JSON.stringify(JSON.parse(f.settings), null, 2)
                        : 'Настройки недоступны'}
                    </pre>
                  </details>
                </section>
              ))}
            {tab === 'unanswered' &&
              d.unanswered.map((turn) => (
                <section className="panel" key={turn.id}>
                  <div className="section-heading">
                    <Badge tone={turn.status === 'failed' ? 'danger' : 'warning'}>
                      {statuses[turn.status]}
                    </Badge>
                    <small>{date(turn.created)}</small>
                  </div>
                  <h2>{turn.question}</h2>
                  <p>{turn.answer || 'Ответ не сформирован.'}</p>
                </section>
              ))}
            {tab === 'checks' && (
              <section className="panel">
                <Table
                  head={['Вопрос', 'Ожидания', 'Действия']}
                  rowKeys={d.checks.map((c) => c.id)}
                  rows={d.checks.map((check) => [
                    <strong>{check.question}</strong>,
                    check.refuse ? (
                      <Badge>Отказ при отсутствии информации</Badge>
                    ) : (
                      <div>
                        <span>
                          {quantity(check.documents.length, 'источник', 'источника', 'источников')}{' '}
                          · {quantity(check.facts.length, 'факт', 'факта', 'фактов')}
                        </span>
                        <small>{check.facts.join(' · ')}</small>
                      </div>
                    ),
                    <div className="actions">
                      <Button onClick={() => edit(check)}>Изменить</Button>
                      <Button
                        className="text-danger"
                        onClick={() =>
                          modal(
                            <>
                              <h2>Удалить контрольный вопрос?</h2>
                              <p>{check.question}</p>
                              <Button
                                className="danger"
                                onClick={async () => {
                                  await api('quality.delete', {
                                    id: check.id,
                                    revision: check.revision,
                                  });
                                  modal(null);
                                  load.reload();
                                }}
                              >
                                Удалить вопрос
                              </Button>
                            </>,
                          )
                        }
                      >
                        Удалить
                      </Button>
                    </div>,
                  ])}
                />
              </section>
            )}
            {tab === 'runs' && d.runs.map((job) => <RunCard key={job.id} job={job} />)}
          </>
        )}
        {d && (
          <Pagination
            page={page}
            pageSize={d.pageSize}
            total={d.totals[tab]}
            onChange={setPage}
            loading={load.loading}
          />
        )}
      </div>
      <div className="info-callout">
        <strong>Проверка не меняет базу знаний</strong>
        <p>
          Ключевые факты проверяются по ожидаемым фразам; итоговый ответ доступен для проверки
          человеком. Исправления вносятся через обычное управление документами.
        </p>
      </div>
    </>
  );
});
