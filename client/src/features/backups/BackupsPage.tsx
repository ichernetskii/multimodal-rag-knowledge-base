import { useEffect } from 'react';
import { api } from '../../shared/api/client';
import { useLoad, useModal } from '../../shared/lib/hooks';
import { useApplication } from '../../shared/lib/application-context';
import { Button } from '../../shared/ui/Button';
import { Loading, PageHeader } from '../../shared/ui/Feedback';
export function Backups() {
  const app = useApplication(),
    modal = useModal(),
    load = useLoad((signal) => api('backup.list', {}, { signal }));
  useEffect(() => {
    const t = setInterval(load.reload, 5000);
    return () => clearInterval(t);
  }, [load.reload]);
  return (
    <>
      <PageHeader
        title={'Company backups'}
        description={
          'Consistent PostgreSQL data and independent S3 file copies. Restore affects only the selected company.'
        }
        actions={
          <Button
            onClick={async () => {
              const job = await api('backup.create');
              app.jobs.upsert(job);
              app.jobs.watch(job);
              app.notify('Backup queued.');
              load.reload();
            }}
          >
            Create backup
          </Button>
        }
      />
      {load.error && <Loading error={load.error} retry={load.reload} />}
      <section className="panel">
        <table>
          <thead>
            <tr>
              <th>Created</th>
              <th>Size</th>
              <th>Verified</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {load.data?.map((b) => (
              <tr key={b.id}>
                <td>
                  {new Date(b.created).toLocaleString()}
                  <br />
                  <code>{b.id}</code>
                </td>
                <td>{(b.bytes / 1024 ** 2).toFixed(1)} MiB</td>
                <td>{b.verified ? 'Yes' : 'Not yet'}</td>
                <td>
                  <Button
                    onClick={async () => {
                      const r = await api('backup.verify', { id: b.id });
                      app.notify('Verification: ' + r.integrity);
                    }}
                  >
                    Verify
                  </Button>
                  <Button
                    disabled={!b.verified}
                    onClick={() =>
                      modal(
                        <>
                          <h2>Restore this company?</h2>
                          <p>
                            This backup will replace the selected company's current data. Running
                            jobs will stop. Other companies will continue working.
                          </p>
                          <Button
                            className="danger"
                            onClick={async () => {
                              const job = await api('backup.restore', { id: b.id });
                              app.jobs.upsert(job);
                              app.jobs.watch(job);
                              modal(null);
                              app.notify('Restore queued.');
                            }}
                          >
                            Restore
                          </Button>
                        </>,
                      )
                    }
                  >
                    Restore
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {load.data?.length === 0 && <p>No backups yet.</p>}
      </section>
    </>
  );
}
