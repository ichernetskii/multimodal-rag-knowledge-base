import { api } from '../../shared/api/client';
import { useApplication } from '../../shared/lib/application-context';
import { useLoad } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Field, Form } from '../../shared/ui/Form';
import { Badge, Loading, Metric, PageHeader } from '../../shared/ui/Feedback';
import { text } from '../../shared/lib/form-data';
export function Tenants() {
  const app = useApplication(),
    load = useLoad((signal) => api('tenants.list', {}, { signal }));
  return (
    <>
      <PageHeader
        title={'Customer companies'}
        description={
          'One shared installation. Each company has its own people, documents, settings, and spending.'
        }
      />
      <div className="admin-role-note">
        <p>
          Creating a company does not grant platform owner access to its members. Switch to a
          company to work with its materials.
        </p>
      </div>
      <section className="panel">
        <div className="section-heading">
          <h2>All companies</h2>
          <Button onClick={load.reload}>Refresh</Button>
        </div>
        {load.error && <Loading error={load.error} retry={load.reload} />}
        <div className="admin-tenant-grid">
          {load.data?.map((t) => (
            <article className="admin-tenant-card" key={t.id}>
              <div>
                <h3>{t.name}</h3>
                <Badge tone={t.blocked ? 'danger' : 'success'}>
                  {t.blocked ? 'Suspended' : 'Active'}
                </Badge>
              </div>
              <div className="actions">
                <Button
                  className={t.blocked ? '' : 'danger'}
                  onClick={async () => {
                    await api('tenants.update', {
                      id: t.id,
                      revision: t.revision,
                      blocked: !t.blocked,
                    });
                    load.reload();
                    await app.session.refresh();
                  }}
                >
                  {t.blocked ? 'Resume access' : 'Suspend access'}
                </Button>
              </div>
              <details className="admin-details">
                <summary>Rename</summary>
                <Form
                  key={t.id + ':' + t.revision}
                  protectChanges
                  label={'Save name'}
                  submit={async (form) => {
                    await api('tenants.update', {
                      id: t.id,
                      revision: t.revision,
                      name: text(form, 'companyName'),
                    });
                    load.reload();
                    await app.session.refresh();
                    app.notify('Company name updated.');
                  }}
                >
                  <Field
                    label={'Company name'}
                    name="companyName"
                    value={t.name}
                    required
                    maxLength={200}
                  />
                </Form>
              </details>
            </article>
          ))}
        </div>
      </section>
      <section className="panel">
        <h2>Add company</h2>
        <p>
          Creates separate settings, a model catalog, and access for the platform owner. Invite
          members from the company's Team &amp; access section.
        </p>
        <Form
          label={'Create company'}
          submit={async (f) => {
            await api('tenants.create', { name: text(f, 'name') });
            load.reload();
            await app.session.refresh();
          }}
        >
          <Field name="name" label={'Company name'} required maxLength={200} />
        </Form>
      </section>
    </>
  );
}
const workers: Record<string, string> = {
  answer: 'User answers',
  document: 'Processing & indexing',
  evaluation: 'Quality evaluation',
  maintenance: 'Maintenance & backups',
  all: 'All job types',
};
export function System() {
  const load = useLoad((signal) => api('diagnostics', {}, { signal })),
    d = load.data;
  return (
    <>
      <PageHeader
        title={'System health'}
        description={
          'Shared dependencies and compute resources. Only the platform owner can access this section.'
        }
        actions={
          <Button disabled={load.loading} onClick={load.reload}>
            {load.loading ? 'Checking…' : 'Refresh checks'}
          </Button>
        }
      />
      {!d ? (
        <Loading error={load.error} retry={load.reload} />
      ) : (
        <>
          <div className="metrics-grid">
            <Metric
              label="PostgreSQL"
              value={d.postgres ? 'Healthy' : 'Error'}
              detail={'Company data & queue'}
            />
            <Metric
              label="S3"
              value={d.storage ? 'Healthy' : 'Error'}
              detail={'Files & derived materials'}
            />
            <Metric
              label="Redis"
              value={d.redis ? 'Healthy' : 'Unavailable'}
              detail={'Cache; jobs remain stored in PostgreSQL'}
            />
            <Metric label={'Workers'} value={d.workers.length} detail={'Recent health signals'} />
          </div>
          <section className="panel">
            <h2>Background workers</h2>
            <div className="admin-status-list">
              {d.workers.map((w) => (
                <div key={w.kind}>
                  <strong>{workers[w.kind] ?? w.kind}</strong>
                  <span>Last signal: {new Date(w.lastSeen).toLocaleTimeString()}</span>
                  <Badge tone="success">Connected</Badge>
                </div>
              ))}
            </div>
            {!d.workers.length && (
              <p role="alert">
                No worker health signals. Check that the Docker workers are running.
              </p>
            )}
          </section>
          <section className="panel">
            <h2>Materials &amp; recognition</h2>
            <div className="admin-status-list">
              {[
                {
                  name: 'PDF text',
                  ready: d.extraction.pdf,
                  issue: d.extraction.pdf ? '' : 'Run yarn prepare:pdf on the server.',
                },
                {
                  name: 'Image OCR',
                  ready: d.extraction.ocr,
                  issue: d.extraction.ocr
                    ? ''
                    : 'Check the OCR installation and selected language.',
                },
                {
                  name: 'FFmpeg',
                  ready: d.media.ffmpeg && d.media.ffprobe,
                  issue: d.media.issues.ffmpeg || d.media.issues.ffprobe,
                },
                {
                  name: 'Whisper',
                  ready: d.media.whisper && d.media.model,
                  issue: d.media.issues.whisper || d.media.issues.model,
                },
              ].map(({ name, ready, issue }) => (
                <div key={name}>
                  <strong>{name}</strong>
                  {!ready && <span>{issue}</span>}
                  <Badge tone={ready ? 'success' : 'danger'}>
                    {ready ? 'Ready' : 'Setup required'}
                  </Badge>
                </div>
              ))}
            </div>
          </section>
          <details className="panel admin-details">
            <summary>Resources &amp; technical details</summary>
            <p>
              CPU: {d.hardware.cpu} · {d.hardware.cores} cores
            </p>
            <p>
              Container environment memory: {(d.hardware.totalMemory / 1024 ** 3).toFixed(1)} GiB,
              free {(d.hardware.freeMemory / 1024 ** 3).toFixed(1)} GiB
            </p>
            <p>Free disk space: {(d.freeBytes / 1024 ** 3).toFixed(1)} GiB</p>
            <p className="muted">
              Docker limits and server secrets belong in deployment configuration.
            </p>
          </details>
        </>
      )}
    </>
  );
}
