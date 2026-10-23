import { useState } from 'react';
import { api } from '../../shared/api/client';
import type {
  AICredential,
  AIProvider,
  Modality,
  ModelProfile,
} from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { text } from '../../shared/lib/form-data';
import { Button } from '../../shared/ui/Button';
import { Form, Field, Check } from '../../shared/ui/Form';
import { PageHeader, Loading } from '../../shared/ui/Feedback';
import { AdminLink } from '../admin/AdminUI';
import {
  providerNames,
  taskNames,
  modalityNames,
  numeric,
  providerInputs,
  providerRoles,
  createProfile,
  needsCredential,
} from './model-catalog';
export function ModelProfileEditor({
  profile,
  credentials,
  loading,
  error,
  reload,
  done,
  cancel,
}: {
  profile: ModelProfile;
  credentials: AICredential[];
  loading: boolean;
  error: string;
  reload: () => void;
  done: () => void;
  cancel: () => void;
}) {
  const app = useApplication(),
    [draft, setDraft] = useState(profile),
    provider = draft.provider;
  const company =
    app.session.tenants.find((tenant) => tenant.id === app.session.user?.tenant)?.name ?? 'Company';
  const changeProvider = (next: AIProvider) =>
    setDraft({ ...createProfile(next), id: profile.id, revision: profile.revision });
  const changeRole = (role: ModelProfile['role']) =>
    setDraft({ ...createProfile(provider, role), id: profile.id, revision: profile.revision });
  return (
    <>
      <PageHeader
        title={draft.revision ? 'Edit AI connection' : 'New AI connection'}
        description={
          'Model catalog for company “' +
          company +
          '”. Only the platform owner can change these settings.'
        }
        actions={
          <Button
            onClick={() => {
              if (app.unsaved.confirmDiscard('page')) cancel();
            }}
          >
            ← Back to connections
          </Button>
        }
      />
      <section className="panel">
        <Form
          protectChanges
          key={draft.id + ':' + draft.revision + ':' + draft.provider + ':' + draft.role}
          disabled={needsCredential(provider) && (loading || Boolean(error))}
          label={'Save profile'}
          submit={async (f) => {
            const profile: ModelProfile = {
              ...draft,
              name: text(f, 'name'),
              model: text(f, 'model'),
              endpoint: text(f, 'endpoint'),
              secretRef: text(f, 'secretRef'),
              provider: text(f, 'provider') as AIProvider,
              role: text(f, 'role') as ModelProfile['role'],
              input: f.getAll('input').map(String) as Modality[],
              enabled: f.has('enabled'),
              cache: f.has('cache'),
              inputMicrosPerMillion: {
                text: Math.round(Number(f.get('inputPrice-text')) * 1e6),
                image: Math.round(Number(f.get('inputPrice-image')) * 1e6),
                audio: Math.round(Number(f.get('inputPrice-audio')) * 1e6),
                video: Math.round(Number(f.get('inputPrice-video')) * 1e6),
              },
              outputMicrosPerMillion: Math.round(Number(f.get('outputPrice')) * 1e6),
            };
            for (const key of Object.keys(numeric) as (keyof typeof numeric)[])
              profile[key] = Number(f.get(key));
            await api('models.save', { profile });
            done();
          }}
        >
          <h2>Basic settings</h2>
          <Field label={'Profile name'} name="name" value={draft.name} required />
          <label>
            Provider
            <select
              name="provider"
              value={provider}
              onChange={(e) => changeProvider(e.target.value as AIProvider)}
              disabled={profile.revision > 0}
            >
              {['google', 'anthropic', 'ollama', 'openai-compatible', 'whisper', 'test'].map(
                (p) => (
                  <option key={p} value={p}>
                    {providerNames[p as AIProvider]}
                  </option>
                ),
              )}
            </select>
          </label>
          {profile.revision > 0 && <input type="hidden" name="provider" value={draft.provider} />}
          <label>
            Task
            <select
              name="role"
              value={draft.role}
              onChange={(event) => changeRole(event.target.value as ModelProfile['role'])}
              disabled={profile.revision > 0}
            >
              {providerRoles(provider).map((p) => (
                <option key={p} value={p}>
                  {taskNames[p]}
                </option>
              ))}
            </select>
          </label>
          {profile.revision > 0 && <input type="hidden" name="role" value={draft.role} />}
          <Field label={'Model'} name="model" value={draft.model} required />
          <p className="muted">
            {provider === 'whisper'
              ? 'Whisper small runs on the server and needs no external address or API key. Configure language and CPU threads in company processing settings.'
              : provider === 'ollama'
                ? 'Enter the Ollama server address and an already downloaded model name. Local models also have context, input-size, timeout, and concurrency limits. Saving a profile does not install model weights.'
                : 'Enter the model, API address, and provider key. For Google transcription, choose the transcription task and Text and Audio inputs, for example gemini-3.8-flash.'}
          </p>
          <Field
            label={'Model server address (endpoint)'}
            name="endpoint"
            value={draft.endpoint}
            readOnly={provider === 'whisper'}
          />
          {needsCredential(provider) ? (
            <label>
              API key
              <select
                key={provider}
                name="secretRef"
                aria-label={'API key'}
                aria-describedby="model-credential-hint"
                defaultValue={draft.provider === provider ? draft.secretRef : ''}
              >
                <option value="">Not selected</option>
                {draft.provider === provider &&
                  draft.secretRef &&
                  !credentials?.some((k) => k.id === draft.secretRef) && (
                    <option value={draft.secretRef} disabled>
                      {draft.secretRef} · key not added yet
                    </option>
                  )}
                {credentials
                  ?.filter((k) => k.provider === provider)
                  .map((k) => (
                    <option key={k.id} value={k.id} disabled={!k.enabled}>
                      {k.label} · {k.id}
                      {k.enabled ? '' : ' · disabled'}
                    </option>
                  ))}
              </select>
              <small id="model-credential-hint">
                Choose a shared provider key. The secret value is never shown here.
              </small>
              <AdminLink to="credentials">Add or rotate a key in the platform registry →</AdminLink>
            </label>
          ) : (
            <>
              <input type="hidden" name="secretRef" value="" />
              <p className="muted">This provider does not require an external API key.</p>
            </>
          )}
          {error && <Loading error={error} retry={reload} />}
          <p className="muted">
            Select only the inputs this specific model supports. Settings cannot add capabilities to
            a model; the server checks adapter constraints and availability.
          </p>
          <div className="form-grid">
            {providerInputs(provider, draft.role).map((m) => (
              <Check
                key={m}
                name="input"
                label={modalityNames[m]}
                value={m}
                checked={draft.input.includes(m)}
              />
            ))}
          </div>
          <details className="admin-details">
            <summary>Context, sizes &amp; call limits</summary>
            <div className="form-grid">
              {(Object.keys(numeric) as (keyof typeof numeric)[]).map((key) =>
                (key === 'dimensions' && draft.role !== 'embedding') ||
                (key === 'maxOutputTokens' && draft.role === 'embedding') ? (
                  <input key={key} type="hidden" name={key} value={draft[key]} />
                ) : (
                  <Field
                    key={key}
                    label={numeric[key]}
                    name={key}
                    value={draft[key]}
                    type="number"
                    min={0}
                    required
                  />
                ),
              )}
            </div>
          </details>
          {needsCredential(provider) ? (
            <details className="admin-details" open={draft.enabled}>
              <summary>External API pricing</summary>
              <p className="muted">
                Enter the provider's current API prices. The system uses them for company budget
                estimates.
              </p>
              <p className="muted">
                Each rate is USD per million input tokens, not per file or second. PDF usage
                includes text and image tokens. If Google provides no breakdown, unknown tokens use
                the highest applicable modality rate and are marked as estimated.
              </p>
              <div className="form-grid">
                {(['text', 'image', 'audio', 'video'] as const).map((m) => (
                  <Field
                    key={m}
                    label={`${modalityNames[m]}: USD per million input tokens`}
                    name={`inputPrice-${m}`}
                    value={draft.inputMicrosPerMillion[m] / 1e6}
                    type="number"
                    step="any"
                    min={0}
                    required
                  />
                ))}
              </div>
              <Field
                label={'Output: USD per million tokens'}
                name="outputPrice"
                value={draft.outputMicrosPerMillion / 1e6}
                type="number"
                step="any"
                min={0}
              />
            </details>
          ) : (
            <>
              {(['text', 'image', 'audio', 'video'] as const).map((kind) => (
                <input key={kind} type="hidden" name={'inputPrice-' + kind} value="0" />
              ))}
              <input type="hidden" name="outputPrice" value="0" />
              <p className="muted">
                Local calls use server resources and have no API provider charge.
              </p>
            </>
          )}
          <Check name="enabled" label={'Enable use'} checked={draft.enabled} />
          <Check name="cache" label={'Use supported context caching'} checked={draft.cache} />
          <Button
            onClick={() => {
              if (app.unsaved.confirmDiscard('page')) cancel();
            }}
          >
            Close form
          </Button>
        </Form>
      </section>
    </>
  );
}
