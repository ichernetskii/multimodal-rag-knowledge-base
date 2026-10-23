import { useState } from 'react';
import { api } from '../../shared/api/client';
import { useApplication } from '../../shared/lib/application-context';
import { useLoad, usePolling } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Form } from '../../shared/ui/Form';
import { Badge, EmptyState, Loading, Metric, PageHeader } from '../../shared/ui/Feedback';
import { ModelAvailability } from '../saas/ModelAvailability';
import { Limits } from '../settings/SettingsPage';
import { AdminLink, money } from './AdminUI';
const indexStates = {
  building: 'Building',
  ready: 'Ready to activate',
  active: 'Active for search',
  failed: 'Build failed',
} as const;
export function Indexes() {
  const app = useApplication(),
    models = useLoad((signal) => api('models.list', {}, { signal })),
    indexes = useLoad((signal) => api('indexes.list', {}, { signal })),
    settings = useLoad((signal) => api('settings.read', {}, { signal }));
  const [selected, setSelected] = useState(''),
    [message, setMessage] = useState('');
  usePolling(indexes.reload, 3000, Boolean(indexes.data?.some((i) => i.state === 'building')));
  const choices = models.data?.filter((p) => p.role === 'embedding' && p.enabled) ?? [],
    profile = choices.find((p) => p.id === (selected || choices[0]?.id)),
    active = models.data?.find((p) => p.id === settings.data?.embeddingProfile),
    activeIndex = indexes.data?.find((index) => index.state === 'active');
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>Search model &amp; index</h2>
          <p>Build a new index before switching models. Your current search remains available.</p>
        </div>
      </div>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Currently used for search</h2>
            <p>
              {models.loading || settings.loading
                ? 'Loading model…'
                : (active?.name ?? 'Search model unavailable')}{' '}
              {active && <code>{active.model}</code>}
            </p>
          </div>
          <Badge tone={activeIndex ? 'success' : 'neutral'}>
            {indexes.loading
              ? 'Checking index…'
              : indexes.error
                ? 'Index status unknown'
                : activeIndex
                  ? 'Index active'
                  : 'Search is not ready yet'}
          </Badge>
        </div>
        <p>
          New documents update the active index automatically. Rebuild when changing the search
          model.
        </p>
        {active && <ModelAvailability profile={active} />}
        {!indexes.loading && !indexes.error && !activeIndex && (
          <p className="info-callout">
            Publish your first material or build an index below. Materials become searchable after
            indexing completes.
          </p>
        )}
      </section>
      {message && (
        <p className="info-callout" role="status">
          {message}
        </p>
      )}
      <section className="panel">
        <h2>Prepare a different index</h2>
        <ol className="admin-steps">
          <li>Choose an available search model.</li>
          <li>Wait for the build to finish. Your current search remains available.</li>
          <li>Review the result, then select Use for search.</li>
        </ol>
        <p>
          If the new model needs text, missing descriptions and transcripts are prepared
          automatically. Existing text is preserved. The image-capable answer model creates
          descriptions; your selected Whisper or Google Gemini profile transcribes speech. External
          calls count toward the company budget. Review the prepared text before activating the new
          search index.
        </p>
        {models.error && <Loading error={models.error} retry={models.reload} />}
        {models.data && !choices.length && (
          <p className="info-callout">
            No approved search models. Ask the platform owner to configure an AI connection.
          </p>
        )}
        <Form
          label={'Build new index'}
          disabled={!profile}
          submit={async () => {
            if (!profile) return;
            const job = await api('indexes.build', { profile: profile.id });
            app.jobs.upsert(job);
            app.jobs.watch(job);
            indexes.reload();
            setMessage('Index build in progress. The list below refreshes automatically.');
          }}
        >
          <label>
            Search model
            <select
              value={profile?.id ?? ''}
              onChange={(e) => setSelected(e.target.value)}
              required
            >
              {choices.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.model}
                </option>
              ))}
            </select>
          </label>
          {profile && <ModelAvailability profile={profile} />}
        </Form>
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>Company indexes</h2>
          <Button onClick={indexes.reload}>Refresh</Button>
        </div>
        {indexes.error && <Loading error={indexes.error} retry={indexes.reload} />}
        {indexes.data?.length === 0 && (
          <EmptyState
            title={'No separate indexes yet'}
            description={'Add documents or prepare a new index with the selected model.'}
          />
        )}
        <div className="admin-index-list">
          {indexes.data?.map((i) => (
            <article className="admin-index" key={i.id}>
              <div>
                <strong>
                  {models.data?.find((p) => p.id === i.profile)?.name ?? 'Search model'}
                </strong>
                <p>
                  {new Date(i.created).toLocaleString()} · {i.documents} documents at build time
                </p>
                <Badge
                  tone={
                    i.state === 'active'
                      ? 'success'
                      : i.state === 'failed'
                        ? 'danger'
                        : i.state === 'building'
                          ? 'info'
                          : 'neutral'
                  }
                >
                  {indexStates[i.state]}
                </Badge>
                <details>
                  <summary>Technical identifier</summary>
                  <code>{i.id}</code>
                </details>
              </div>
              {i.state === 'ready' && (
                <div>
                  <Button
                    disabled={!models.data?.find((p) => p.id === i.profile)?.enabled}
                    onClick={async () => {
                      await api('indexes.activate', { id: i.id });
                      indexes.reload();
                      settings.reload();
                      setMessage('The selected search index is now active.');
                    }}
                  >
                    Use for search
                  </Button>
                  {models.data && !models.data.find((p) => p.id === i.profile)?.enabled && (
                    <p className="muted">
                      This model profile is disabled. The platform owner must enable it before
                      activation.
                    </p>
                  )}
                </div>
              )}
              {i.state === 'failed' && (
                <AdminLink to="maintenance" tab="jobs">
                  View job error
                </AdminLink>
              )}
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
export function Usage() {
  const app = useApplication(),
    usage = useLoad((signal) => api('usage.read', {}, { signal })),
    models = useLoad((signal) => api('models.list', {}, { signal }));
  const value = usage.data;
  return (
    <>
      <PageHeader
        title={'Usage & limits'}
        description={'Budget, model usage, and resources for the selected company.'}
        actions={<Button onClick={() => usage.reload()}>Refresh</Button>}
      />
      {!value ? (
        <Loading error={usage.error} retry={usage.reload} />
      ) : (
        <>
          <div className="metrics-grid">
            <Metric
              label={'Monthly spending'}
              value={money(value.spentMicros)}
              detail={value.month}
            />
            <Metric
              label={'AI budget'}
              value={money(value.budgetMicros)}
              detail={'Company spending limit'}
            />
            <Metric
              label={'Reserved'}
              value={money(value.reservedMicros)}
              detail={'Model calls awaiting completion'}
            />
            <Metric
              label={'Files'}
              value={(value.storageBytes / 1024 ** 2).toFixed(1) + ' MiB'}
              detail={'Original and derived materials'}
            />
          </div>
          {value.uncertainMicros > 0 && (
            <p role="alert" className="info-callout">
              Some attempts have an unconfirmed result totaling {money(value.uncertainMicros)}.
              Check your AI provider usage before retrying.
            </p>
          )}
          <section className="panel">
            <h2>Model usage</h2>
            <p>
              Costs are estimates based on configured prices. Local calls have no API provider
              charge but use your server resources.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Calls</th>
                    <th>Tokens: input / output</th>
                    <th>Input by modality</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {value.calls.map((c) => (
                    <tr key={c.profile}>
                      <td>
                        {models.data?.find((p) => p.id === c.profile)?.name ?? 'Model profile'}
                      </td>
                      <td>{c.calls}</td>
                      <td>
                        {c.input} / {c.output}
                      </td>
                      <td>
                        {(
                          [
                            ['text', 'Text'],
                            ['image', 'Images'],
                            ['audio', 'Audio'],
                            ['video', 'Video'],
                            ['unattributed', 'No breakdown'],
                          ] as const
                        ).map(
                          ([kind, label]) =>
                            c.modalities[kind].tokens > 0 && (
                              <div key={kind}>
                                {label}: {c.modalities[kind].tokens} tokens ·{' '}
                                {money(c.modalities[kind].costMicros)}
                              </div>
                            ),
                        )}
                        {c.estimatedCalls > 0 && (
                          <p className="muted">
                            Estimated calls: {c.estimatedCalls}. Check the final invoice with your
                            provider.
                          </p>
                        )}
                      </td>
                      <td>{money(c.costMicros)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!value.calls.length && <p className="muted">No model calls this month.</p>}
          </section>
        </>
      )}
      <Limits onSaved={usage.reload} />
      <details className="panel admin-details">
        <summary>Cache maintenance</summary>
        <p>
          Use after troubleshooting. Material and permission changes invalidate the relevant cache
          automatically.
        </p>
        <Button
          onClick={async () => {
            await api('cache.clear');
            app.notify('Company search and answer caches cleared.');
          }}
        >
          Clear company cache
        </Button>
      </details>
    </>
  );
}
const actionNames: Record<string, string> = {
  'documents.upload': 'Document upload',
  'documents.delete': 'Document deletion',
  'collections.save': 'Knowledge base change',
  'models.save': 'AI connection change',
  'settings.save': 'Settings change',
  'tenants.create': 'Company creation',
  'indexes.activate': 'Search index activation',
};
export function Audit() {
  const [page, setPage] = useState(1),
    load = useLoad((signal) => api('audit.list', { page, pageSize: 25 }, { signal }), [page]);
  return (
    <>
      <PageHeader
        title={'Activity log'}
        description={'Actions and changes in the selected company. Other companies are excluded.'}
        actions={<Button onClick={load.reload}>Refresh</Button>}
      />
      <section className="panel">
        {!load.data ? (
          <Loading error={load.error} retry={load.reload} />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>What happened</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {load.data.items.map((item) => (
                    <tr key={item.id}>
                      <td>{new Date(item.created).toLocaleString()}</td>
                      <td>{actionNames[item.action] ?? item.action}</td>
                      <td>
                        <details>
                          <summary>Identifiers</summary>
                          <p>
                            Action: <code>{item.action}</code>
                          </p>
                          <p>
                            Member: <code>{item.actor}</code>
                          </p>
                          <p>
                            Object: <code>{item.target || '—'}</code>
                          </p>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!load.data.items.length && (
              <EmptyState
                title={'No activity yet'}
                description={'Document, access, and settings changes will appear here.'}
              />
            )}
            <div className="admin-pagination">
              <Button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span>Page {page}</span>
              <Button disabled={page * 25 >= load.data.total} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </>
        )}
      </section>
    </>
  );
}
