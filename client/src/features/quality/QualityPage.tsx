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
  wrong_source: 'Incorrect source',
  outdated: 'Outdated information',
  no_answer: 'No answer',
  irrelevant_answer: 'Unhelpful answer',
  other: 'Other reason',
} as const;
const tabs = {
  feedback: 'Feedback',
  unanswered: 'Unanswered',
  checks: 'Test questions',
  runs: 'Evaluation results',
} as const;
function CheckEditor({ check, done }: { check?: CheckQuestion; done: () => void }) {
  const app = useApplication(),
    [documents, setDocuments] = useState(check?.documents ?? []);
  return (
    <>
      <p className="eyebrow">QUALITY CONTROL</p>
      <h2>{check ? 'Edit test question' : 'New test question'}</h2>
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
        <Field
          label={'Question'}
          name="question"
          type="textarea"
          value={check?.question}
          required
        />
        <Select
          label={'Knowledge base'}
          name="collection"
          value={check?.scope.collection ?? ''}
          options={[
            ['', 'All available'],
            ...app.bases.items.map((c) => [c.id, c.name] as [string, string]),
          ]}
        />
        <DocumentPicker selected={documents} onChange={setDocuments} />
        <Field
          label={'Expected key facts'}
          name="facts"
          type="textarea"
          value={check?.facts.join('\n')}
          hint={
            'One fact per line. Evaluation looks for these phrases in the answer, ignoring case.'
          }
        />
        <Check
          label={'Expect refusal when information is missing'}
          name="refuse"
          checked={check?.refuse}
          hint={'Sources and key facts are optional for this type of question.'}
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
          app.notify('Test question saved.');
        }}
      />,
    );
  return (
    <>
      <PageHeader
        eyebrow={'ANSWER EVALUATION'}
        title={'Quality'}
        description={
          'Review feedback and evaluate answers after changing models, search, or documents.'
        }
        actions={
          <>
            <Button onClick={() => edit()}>+ Test question</Button>
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
                app.notify('Evaluation queued.');
              }}
            >
              Run evaluation
            </Button>
          </>
        }
      />
      <div className="tabs" role="tablist" aria-label={'Quality control'}>
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
                  ? 'Feedback will appear here'
                  : tab === 'unanswered'
                    ? 'No unanswered questions yet'
                    : tab === 'checks'
                      ? 'Add test questions'
                      : 'No evaluations run yet'
              }
              description={
                tab === 'feedback'
                  ? 'Users can rate answers and explain issues.'
                  : tab === 'unanswered'
                    ? 'Refusals, clarifications, and technical errors are saved for review.'
                    : tab === 'checks'
                      ? 'Set expected sources and facts to compare results after changes.'
                      : 'Create test questions and run an evaluation.'
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
                        {source.name} · p. {source.page}
                      </Button>
                    ))}
                  </div>
                  <details>
                    <summary>Settings &amp; source versions</summary>
                    <p>{f.sources.map((s) => s.name + ' · ' + s.version.slice(0, 8)).join(', ')}</p>
                    <pre className="json-view">
                      {f.settings
                        ? JSON.stringify(JSON.parse(f.settings), null, 2)
                        : 'Settings unavailable'}
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
                  <p>{turn.answer || 'No answer was generated.'}</p>
                </section>
              ))}
            {tab === 'checks' && (
              <section className="panel">
                <Table
                  head={['Question', 'Expectations', 'Actions']}
                  rowKeys={d.checks.map((c) => c.id)}
                  rows={d.checks.map((check) => [
                    <strong>{check.question}</strong>,
                    check.refuse ? (
                      <Badge>Refuse when information is missing</Badge>
                    ) : (
                      <div>
                        <span>
                          {quantity(check.documents.length, 'source', 'sources')} ·{' '}
                          {quantity(check.facts.length, 'fact', 'facts')}
                        </span>
                        <small>{check.facts.join(' · ')}</small>
                      </div>
                    ),
                    <div className="actions">
                      <Button onClick={() => edit(check)}>Edit</Button>
                      <Button
                        className="text-danger"
                        onClick={() =>
                          modal(
                            <>
                              <h2>Delete this test question?</h2>
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
                                Delete question
                              </Button>
                            </>,
                          )
                        }
                      >
                        Delete
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
        <strong>Evaluation does not change the knowledge base</strong>
        <p>
          Key facts are checked using expected phrases; people can review the full answer. Make
          corrections through normal document management.
        </p>
      </div>
    </>
  );
});
