import { useState } from 'react';
import { api } from '../../shared/api/client';
import type { Job } from '../../shared/api/contracts.generated';
import { terminal } from '../../shared/api/contracts.generated';
import { date, duration } from '../../shared/lib/format';
import { useLoad, useModal, usePolling } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Badge, Loading } from '../../shared/ui/Feedback';
import { Pagination, Table } from '../../shared/ui/DataTable';
import { Source } from '../documents/SourceDialog';
import { statuses } from '../jobs/job-status';
const Passed = ({ ok }: { ok: boolean }) => (
  <Badge tone={ok ? 'success' : 'danger'}>{ok ? 'Passed' : 'Error'}</Badge>
);
function Results({ job }: { job: Job }) {
  const modal = useModal(),
    [page, setPage] = useState(1),
    load = useLoad(
      (signal) => api('quality.results', { job: job.id, page, pageSize: 10 }, { signal }),
      [job.id, page, job.updated],
    );
  usePolling(load.reload, terminal.has(job.status) ? 60000 : 5000);
  return (
    <>
      {load.error && <Loading error={load.error} retry={load.reload} />}{' '}
      {load.data ? (
        <>
          <Table
            head={['Question', 'Source', 'Facts', 'Citations', 'Refusal', 'Time']}
            rowKeys={load.data.items.map((r) => r.id)}
            empty={'No completed results yet.'}
            rows={load.data.items.map((result) => [
              <details>
                <summary>{result.question}</summary>
                <p>{result.answer}</p>
                {result.error && (
                  <p className="error">
                    {result.error.code} · {result.error.diagnostic}
                  </p>
                )}
                <div className="source-chips">
                  {result.sources.map((source) => (
                    <Button key={source.chunk} onClick={() => modal(<Source source={source} />)}>
                      {source.name} · p. {source.page}
                    </Button>
                  ))}
                </div>
                <p>Expected facts: {result.expected.facts.join(' · ') || '—'}</p>
                <details>
                  <summary>Processing settings</summary>
                  <pre className="json-view">
                    {JSON.stringify(JSON.parse(result.settings), null, 2)}
                  </pre>
                </details>
              </details>,
              <Passed ok={result.sourceRetrieval} />,
              <Passed ok={result.answerFacts} />,
              <Passed ok={result.citationsValid} />,
              <Passed ok={result.refusalCorrect} />,
              duration(result.milliseconds),
            ])}
          />
          <Pagination
            page={page}
            pageSize={10}
            total={load.data.total}
            onChange={setPage}
            loading={load.loading}
          />
        </>
      ) : (
        <Loading />
      )}
    </>
  );
}
export function RunCard({ job }: { job: Job }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Evaluation from {date(job.created)}</h2>
          <p>{job.id.slice(0, 8)}</p>
        </div>
        <Badge
          tone={
            job.status === 'complete'
              ? job.result.failed
                ? 'warning'
                : 'success'
              : job.status === 'failed'
                ? 'danger'
                : 'info'
          }
        >
          {statuses[job.status]}
        </Badge>
      </div>
      {job.error && (
        <p className="inline-error">
          {typeof job.result.message === 'string' ? job.result.message : job.error}
        </p>
      )}
      <div className="actions">
        <Badge>
          Processed: {Number(job.result.processed ?? 0)} / {Number(job.result.total ?? 0)}
        </Badge>
        <Badge tone="success">Passed: {Number(job.result.passed ?? 0)}</Badge>
        <Badge tone={job.result.failed ? 'danger' : 'neutral'}>
          Failed: {Number(job.result.failed ?? 0)}
        </Badge>
        <Button aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide results' : 'View results'}
        </Button>
      </div>
      {open && <Results job={job} />}
    </section>
  );
}
