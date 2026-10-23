import { useState } from 'react';
import { api } from '../../shared/api/client';
import { useLoad, usePolling } from '../../shared/lib/hooks';
import { useApplication } from '../../shared/lib/application-context';
import { Button } from '../../shared/ui/Button';
import { Loading, PageHeader } from '../../shared/ui/Feedback';
import { statuses } from '../jobs/job-status';
const kindNames: Record<string, string> = {
  answer: 'User answer',
  document: 'Document processing',
  index: 'Index rebuild',
  evaluation: 'Quality evaluation',
  maintenance: 'Maintenance',
  backup: 'Backup',
  restore: 'Restore',
  cleanup: 'Cleanup',
  sync: 'Synchronization',
};
const finished = ['complete', 'no_info', 'clarification', 'cancelled', 'failed', 'interrupted'];
export function Operations() {
  const app = useApplication(),
    load = useLoad((signal) => api('operations', {}, { signal })),
    jobs = useLoad((signal) => api('jobs.list', { pageSize: 100 }, { signal }));
  const [filter, setFilter] = useState('all');
  usePolling(load.reload);
  usePolling(jobs.reload);
  const data = load.data;
  return (
    <>
      <PageHeader
        title={'Jobs & queues'}
        description={
          'Queues and data for the current company. Generation and indexing have independent limits.'
        }
        actions={
          <Button
            onClick={() => {
              load.reload();
              jobs.reload();
            }}
          >
            Refresh
          </Button>
        }
      />
      {!data ? (
        <Loading error={load.error} retry={load.reload} />
      ) : (
        <>
          <section className="panel">
            <h2>Company workload</h2>
            <p>
              Queued: {data.queue.length} · Oldest job: {Math.round(data.queue.oldestAgeMs / 1000)}{' '}
              s · Files: {(data.dataBytes / 1024 ** 2).toFixed(1)} MiB
            </p>
            <div className="form-grid">
              {data.queue.lanes.map((l) => (
                <div key={l.kind}>
                  <strong>{kindNames[l.kind] ?? l.kind}</strong>
                  <p>{l.length} jobs</p>
                </div>
              ))}
            </div>
            <details className="admin-details">
              <summary>Data maintenance</summary>
              <p>Remove expired company data according to processing and retention settings.</p>
              <Button
                onClick={async () => {
                  const job = await api('cleanup');
                  app.jobs.upsert(job);
                  app.jobs.watch(job);
                  app.notify('Cleanup queued.');
                }}
              >
                Run cleanup
              </Button>
            </details>
          </section>
          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>Recent jobs</h2>
                <p>The company's latest 100 jobs. This list refreshes automatically.</p>
              </div>
              <label>
                Show
                <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                  <option value="all">All jobs</option>
                  <option value="active">In progress</option>
                  <option value="failed">Failed</option>
                  <option value="complete">Completed</option>
                </select>
              </label>
            </div>
            {jobs.error && <Loading error={jobs.error} retry={jobs.reload} />}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Status</th>
                    <th>Error / result</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.data?.items
                    .filter(
                      (j) =>
                        filter === 'all' ||
                        (filter === 'active'
                          ? !finished.includes(j.status)
                          : filter === 'failed'
                            ? ['failed', 'interrupted'].includes(j.status)
                            : ['complete', 'no_info', 'clarification', 'cancelled'].includes(
                                j.status,
                              )),
                    )
                    .map((j) => (
                      <tr key={j.id}>
                        <td>
                          <strong>{kindNames[j.kind] ?? j.kind}</strong>
                          <details>
                            <summary>Job ID</summary>
                            <code>{j.id}</code>
                          </details>
                        </td>
                        <td>{statuses[j.status]}</td>
                        <td>
                          {j.error}
                          <br />
                          {typeof j.result.message === 'string' ? j.result.message : ''}
                        </td>
                        <td>
                          {![
                            'complete',
                            'no_info',
                            'clarification',
                            'cancelled',
                            'failed',
                            'interrupted',
                          ].includes(j.status) ? (
                            <Button
                              onClick={async () => {
                                await api('jobs.cancel', { id: j.id });
                                jobs.reload();
                              }}
                            >
                              Cancel
                            </Button>
                          ) : (
                            ['failed', 'interrupted'].includes(j.status) && (
                              <Button
                                onClick={async () => {
                                  const next = await api('jobs.retry', { id: j.id });
                                  app.jobs.upsert(next);
                                  app.jobs.watch(next);
                                  jobs.reload();
                                }}
                              >
                                Retry as a separate attempt
                              </Button>
                            )
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
