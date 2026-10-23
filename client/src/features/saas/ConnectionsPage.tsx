import { useState } from 'react';
import { api } from '../../shared/api/client';
import type { ModelProfile } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { useLoad } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { PageHeader, Loading } from '../../shared/ui/Feedback';
import { ModelAvailability } from './ModelAvailability';
import {
  providerNames,
  taskNames,
  modalityNames,
  createProfile,
  isOwnServer,
  needsCredential,
} from '../models/model-catalog';
import { ModelProfileEditor } from '../models/ModelProfileEditor';
import { AdminLink } from '../admin/AdminUI';
import { Badge } from '../../shared/ui/Feedback';
export function Connections() {
  const app = useApplication(),
    models = useLoad((signal) => api('models.list', {}, { signal })),
    keys = useLoad((signal) => api('secrets.list', {}, { signal }));
  const [editing, setEditing] = useState<ModelProfile | null>(null),
    [availabilityRefresh, setAvailabilityRefresh] = useState(0);
  const editProfile = (p: ModelProfile) => {
    setEditing(p);
  };
  const operator = Boolean(app.session.user?.operator);
  const company =
    app.session.tenants.find((t) => t.id === app.session.user?.tenant)?.name ?? 'company';
  if (editing)
    return (
      <ModelProfileEditor
        profile={editing}
        credentials={keys.data ?? []}
        loading={keys.loading}
        error={keys.error}
        reload={keys.reload}
        done={() => {
          setEditing(null);
          models.reload();
          keys.reload();
        }}
        cancel={() => setEditing(null)}
      />
    );
  return (
    <>
      <PageHeader
        title={'Connected models'}
        description={
          'Model profiles for company “' +
          company +
          '”. Shared API keys are configured separately in the platform section.'
        }
        actions={
          <>
            <Button className="primary" onClick={() => editProfile(createProfile())}>
              + Connect model
            </Button>
            <Button onClick={() => editProfile(createProfile('google', 'transcription'))}>
              + Google transcription
            </Button>
          </>
        }
      />
      <div className="info-callout">
        Profiles belong to this company. <AdminLink to="credentials">Platform API keys →</AdminLink>
      </div>
      <section className="panel">
        <h2>Model profiles</h2>
        <p>
          For external models, choose a key from the platform registry. Company administrators
          cannot see key values or change connections. TEST AI is for development and verification.
        </p>
        <p>
          Enabling a profile does not install the model or start Ollama. Availability is checked
          from the server when you open this section; this check does not generate a paid answer.
        </p>
        <Button onClick={() => setAvailabilityRefresh((n) => n + 1)}>Check all models</Button>
        {models.error && <Loading error={models.error} retry={models.reload} />}
        {[
          {
            kind: 'local',
            own: true,
            title: 'On your server',
            description:
              'Whisper runs on the application server. Ollama uses your configured model server address.',
          },
          {
            kind: 'api',
            own: false,
            title: 'External API',
            description:
              'Google, Anthropic, and compatible API servers. A compatible server can be self-hosted; its address determines where it runs.',
          },
          {
            kind: 'test',
            own: false,
            title: 'Development & verification',
            description:
              'Deterministic checks run inside this application without external model calls or provider charges.',
          },
        ].map((group) => (
          <section className="model-provider-group" key={group.title}>
            <h3>{group.title}</h3>
            <p className="muted">{group.description}</p>
            <div className="model-profiles">
              {models.data
                ?.filter((p) =>
                  group.kind === 'test'
                    ? p.provider === 'test'
                    : p.provider !== 'test' && isOwnServer(p.provider) === group.own,
                )
                .map((p) => (
                  <article className="model-profile" key={p.id} aria-label={p.name}>
                    <h3>{p.name}</h3>
                    <Badge tone={isOwnServer(p.provider) ? 'success' : 'info'}>
                      {p.provider === 'test'
                        ? 'TEST AI'
                        : isOwnServer(p.provider)
                          ? 'Self-hosted'
                          : 'API'}
                    </Badge>
                    <p>
                      <code>{p.model}</code> · {p.enabled ? 'Enabled' : 'Disabled'}
                    </p>
                    <p>
                      {providerNames[p.provider]} · {taskNames[p.role]}
                      <br />
                      Input: {p.input.map((m) => modalityNames[m]).join(', ')}
                    </p>
                    {needsCredential(p.provider) && (
                      <p>
                        Key:{' '}
                        <AdminLink to="credentials">
                          {keys.data?.find((key) => key.id === p.secretRef)?.label ??
                            (p.secretRef || 'Not selected')}
                        </AdminLink>
                        {' · '}
                        {keys.loading
                          ? 'Checking…'
                          : keys.error
                            ? 'Status unknown'
                            : keys.data?.some((key) => key.id === p.secretRef && key.enabled)
                              ? 'Enabled'
                              : 'Setup required'}
                      </p>
                    )}
                    <ModelAvailability profile={p} refresh={availabilityRefresh} />
                    <div className="model-profile-actions">
                      {operator && <Button onClick={() => editProfile(p)}>Edit</Button>}
                      {operator && (
                        <Button
                          onClick={() =>
                            editProfile({
                              ...p,
                              id: crypto.randomUUID(),
                              revision: 0,
                              name: p.name + ' — copy',
                              enabled: false,
                            })
                          }
                        >
                          Copy
                        </Button>
                      )}
                      {operator && (
                        <Button
                          onClick={async () => {
                            await api('models.delete', { id: p.id, revision: p.revision });
                            models.reload();
                          }}
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                  </article>
                ))}
            </div>
          </section>
        ))}
      </section>
    </>
  );
}
