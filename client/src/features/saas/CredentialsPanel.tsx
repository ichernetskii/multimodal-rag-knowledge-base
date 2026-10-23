import { useState } from 'react';
import { api } from '../../shared/api/client';
import type { AICredential, CredentialAudit } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { useLoad } from '../../shared/lib/hooks';
import { text, option } from '../../shared/lib/form-data';
import { Button } from '../../shared/ui/Button';
import { Field, Form, Check } from '../../shared/ui/Form';
import { Badge, Loading } from '../../shared/ui/Feedback';
export const credentialProviders = {
  google: 'Google Gemini',
  anthropic: 'Anthropic Claude',
  'openai-compatible': 'OpenAI-compatible server',
} as const;
const auditNames: Record<CredentialAudit['action'], string> = {
  created: 'Added',
  updated: 'Settings changed',
  rotated: 'Value rotated',
  enabled: 'Enabled',
  disabled: 'Disabled',
  deleted: 'Deleted',
};
export function CredentialsPanel({
  credentials,
  loading,
  error,
  reload,
  onChanged,
}: {
  credentials: AICredential[];
  loading: boolean;
  error: string;
  reload: () => void;
  onChanged: () => void;
}) {
  const app = useApplication(),
    [editing, setEditing] = useState<AICredential | 'new' | null>(null),
    [deleting, setDeleting] = useState<AICredential | null>(null),
    [page, setPage] = useState(1);
  const audit = useLoad(
    (signal) => api('secrets.audit', { page, pageSize: 25 }, { signal }),
    [page],
  );
  const changed = () => {
    onChanged();
    audit.reload();
  };
  const old = editing && editing !== 'new' ? editing : null;
  const editKey = (value: typeof editing) => {
    if (!app.unsaved.confirmDiscard('page')) return false;
    setEditing(value);
    return true;
  };
  return (
    <section className="panel admin-credentials">
      <div className="section-heading">
        <div>
          <h2>Platform API keys</h2>
          <p>Shared across all companies. Only the platform owner can manage them.</p>
        </div>
        <div className="actions">
          <Button
            onClick={() => {
              reload();
              audit.reload();
            }}
          >
            Refresh registry
          </Button>
          <Button
            className="primary"
            onClick={() => {
              if (editKey('new')) setDeleting(null);
            }}
          >
            + Add API key
          </Button>
        </div>
      </div>
      <p>
        Values are encrypted on the server and never shown after saving. Additions, rotations, and
        disabling apply to new API and worker calls without a restart.
      </p>
      {error && <Loading error={error} retry={reload} />}
      {editing && (
        <div className="admin-credential-form">
          <div className="section-heading">
            <h3>{old ? 'Edit key “' + old.label + '»' : 'Add API key'}</h3>
            <Button onClick={() => editKey(null)}>Close</Button>
          </div>
          <Form
            protectChanges
            autoComplete="off"
            key={old ? old.id + ':' + old.revision : 'new'}
            label={old ? 'Save key changes' : 'Save API key'}
            submit={async (f) => {
              const value = text(f, 'apiCredentialValue');
              await api('secrets.save', {
                id: text(f, 'credentialId'),
                label: text(f, 'credentialLabel'),
                provider: option(f, 'provider', [
                  'google',
                  'anthropic',
                  'openai-compatible',
                ] as const),
                revision: old?.revision ?? 0,
                enabled: f.has('enabled'),
                ...(value ? { value } : {}),
              });
              setEditing(null);
              changed();
              app.notify(
                old
                  ? 'Key changes applied. No restart required.'
                  : 'API key saved. You can now select it in a model connection.',
              );
            }}
          >
            <div className="form-grid">
              <Field
                label={'Key name'}
                name="credentialLabel"
                value={old?.label}
                required
                maxLength={120}
                hint={'For example, Google · primary. Do not paste the secret here.'}
              />
              <Field
                label={'Key identifier'}
                name="credentialId"
                value={old?.id}
                required
                readOnly={!!old}
                maxLength={64}
                autoComplete="off"
                hint={
                  'Lowercase letters, numbers, _ and -. For example, google or google-production.'
                }
              />
            </div>
            <label>
              Key provider
              <select name="provider" defaultValue={old?.provider ?? 'google'} disabled={!!old}>
                {Object.entries(credentialProviders).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            {old && <input type="hidden" name="provider" value={old.provider} />}
            <Field
              label={old ? 'New API key value' : 'API key value'}
              name="apiCredentialValue"
              type="password"
              autoComplete="new-password"
              autoCapitalize="none"
              spellCheck={false}
              required={!old}
              maxLength={8192}
              minLength={8}
              hint={
                old
                  ? 'Leave empty to keep the current value. Paste a new key to rotate it; the old value is never returned.'
                  : 'Paste the key from your provider. It is sent only to our server and stored encrypted.'
              }
            />
            <Check
              name="enabled"
              label={'Allow new calls with this key'}
              checked={old?.enabled ?? true}
            />
          </Form>
        </div>
      )}
      {!credentials.length && !loading && !error && (
        <p className="info-callout">
          No external API keys yet. Ollama and built-in Whisper work without them.
        </p>
      )}
      {loading && !credentials.length && !error && <Loading />}
      {Boolean(credentials.length) && (
        <div className="credential-list">
          {credentials.map((c) => (
            <article className="credential-card" key={c.id} aria-label={'API key: ' + c.label}>
              <div className="section-heading">
                <div>
                  <h3>{c.label}</h3>
                  <code>{c.id}</code>
                </div>
                <Badge tone={c.enabled ? 'success' : 'neutral'}>
                  {c.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
              <p>
                {credentialProviders[c.provider]} · {c.uses} profiles across all companies
              </p>
              <p className="muted">Value hidden · changed {new Date(c.updated).toLocaleString()}</p>
              <div className="actions">
                <Button
                  onClick={() => {
                    if (editKey(c)) setDeleting(null);
                  }}
                >
                  Edit / rotate
                </Button>
                <Button
                  onClick={async () => {
                    await api('secrets.save', {
                      id: c.id,
                      label: c.label,
                      provider: c.provider,
                      enabled: !c.enabled,
                      revision: c.revision,
                    });
                    changed();
                    app.notify(
                      c.enabled
                        ? 'Key disabled for new calls across all companies.'
                        : 'Key enabled for new calls.',
                    );
                  }}
                >
                  {c.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button
                  className="danger"
                  disabled={c.uses > 0}
                  title={
                    c.uses
                      ? 'First change the key in every profile using it'
                      : 'Delete from encrypted storage'
                  }
                  onClick={() => {
                    if (editKey(null)) setDeleting(c);
                  }}
                >
                  Delete
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
      {deleting && (
        <div className="info-callout" role="alertdialog" aria-label={'Delete API key'}>
          <strong>Delete key “{deleting.label}»?</strong>
          <p>
            Its value cannot be recovered from the admin UI. Deleting it here does not revoke it
            with the provider.
          </p>
          <div className="actions">
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              className="danger"
              onClick={async () => {
                await api('secrets.delete', { id: deleting.id, revision: deleting.revision });
                setDeleting(null);
                changed();
                app.notify('Key deleted.');
              }}
            >
              Confirm deletion
            </Button>
          </div>
        </div>
      )}
      <p className="muted">
        To delete a referenced key, first select another key in its model profiles. Disabling stops
        new provider calls; requests already sent may finish. To test a key, select it in a
        connection and check model availability.
      </p>
      <details className="admin-details">
        <summary>API key activity</summary>
        {audit.error && <Loading error={audit.error} retry={audit.reload} />}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Key</th>
                <th>Action</th>
                <th>Who</th>
              </tr>
            </thead>
            <tbody>
              {audit.data?.items.map((a) => (
                <tr key={a.id}>
                  <td>{new Date(a.created).toLocaleString()}</td>
                  <td>
                    <code>{a.credential}</code>
                  </td>
                  <td>
                    {auditNames[a.action]} · {a.enabled ? 'enabled' : 'disabled'}
                  </td>
                  <td>{a.actorLogin}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {audit.data && !audit.data.items.length && <p className="muted">No changes yet.</p>}
        <div className="admin-pagination">
          <Button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span>Page {page}</span>
          <Button
            disabled={!audit.data || page * audit.data.pageSize >= audit.data.total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </details>
    </section>
  );
}
