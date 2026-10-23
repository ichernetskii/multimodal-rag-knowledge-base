import { useState } from 'react';
import { api } from '../../shared/api/client';
import type { Settings, ModelProfile } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { useLoad } from '../../shared/lib/hooks';
import { text } from '../../shared/lib/form-data';
import { Field, Form, Check } from '../../shared/ui/Form';
import { Loading, PageHeader } from '../../shared/ui/Feedback';
import { ModelAvailability } from '../saas/ModelAvailability';
import { AdminLink } from '../admin/AdminUI';
const limits = {
  maxBytes: ['File size, MiB', 1024 ** 2],
  maxPages: ['Material pages / segments', 1],
  maxTextCharacters: ['Extracted text, characters', 1],
  maxChunks: ['Document chunks', 1],
  maxDocuments: ['Documents', 1],
  maxQueue: ['Accepted unfinished jobs', 1],
  answerConcurrency: ['Concurrent answers', 1],
  indexConcurrency: ['Concurrent background jobs', 1],
  storageBytes: ['File storage, GiB', 1024 ** 3],
  monthlyBudgetMicros: ['Monthly AI budget, USD', 1e6],
  maxOutputTokens: ['Maximum output tokens', 1],
  contextTokens: ['Context budget, tokens', 1],
  topK: ['Sources per answer', 1],
  cacheSeconds: ['Answer & search cache TTL, seconds', 1],
  sessionHours: ['Session duration, hours', 1],
  historyDays: ['History retention, days', 1],
  jobDays: ['Job retention, days', 1],
  tempHours: ['Incomplete upload retention, hours', 1],
  logDays: ['Activity log retention, days', 1],
  backupDays: ['Backup retention, days', 1],
  backupIntervalHours: ['Backup interval, hours; 0 for manual', 1],
  ocrTimeoutSeconds: ['OCR timeout per page, seconds', 1],
  ocrMemoryMB: ['OCR memory, MiB', 1],
  whisperThreads: ['Whisper CPU threads', 1],
  mediaMaxSeconds: ['Recording duration, seconds', 1],
  mediaTimeoutSeconds: ['Media processing timeout, seconds', 1],
  videoMaxFrames: ['Target video segment count', 1],
  mediaImageMaxSide: ['Maximum image side, pixels', 1],
  answerMaxImages: ['Media segments per answer', 1],
} as const;
type NumericKey = keyof typeof limits;
type Mode = 'assistant' | 'limits' | 'processing';
const groups: Record<Mode, { title: string; description: string; keys: NumericKey[] }[]> = {
  assistant: [
    {
      title: 'Answers & search',
      description: 'Applies to new user questions.',
      keys: ['maxOutputTokens', 'contextTokens', 'topK', 'answerMaxImages', 'cacheSeconds'],
    },
  ],
  limits: [
    {
      title: 'Company resources',
      description: 'Generation and indexing have separate limits.',
      keys: [
        'maxDocuments',
        'storageBytes',
        'maxQueue',
        'answerConcurrency',
        'indexConcurrency',
        'monthlyBudgetMicros',
      ],
    },
  ],
  processing: [
    {
      title: 'Documents',
      description: 'Maximum file size and extracted data limits.',
      keys: ['maxBytes', 'maxPages', 'maxTextCharacters', 'maxChunks'],
    },
    {
      title: 'Images, audio & video',
      description: 'Sizes, duration, and processing resources.',
      keys: [
        'mediaMaxSeconds',
        'mediaTimeoutSeconds',
        'videoMaxFrames',
        'mediaImageMaxSide',
        'ocrTimeoutSeconds',
        'ocrMemoryMB',
        'whisperThreads',
      ],
    },
    {
      title: 'Retention & sessions',
      description: 'Retention periods apply to the selected company.',
      keys: [
        'sessionHours',
        'historyDays',
        'jobDays',
        'tempHours',
        'logDays',
        'backupDays',
        'backupIntervalHours',
      ],
    },
  ],
};
const planKeys: NumericKey[] = [
  'maxBytes',
  'maxDocuments',
  'storageBytes',
  'maxQueue',
  'answerConcurrency',
  'indexConcurrency',
  'monthlyBudgetMicros',
];
export function Assistant() {
  return <SettingsForm mode="assistant" />;
}
export function Limits({ onSaved }: { onSaved?: () => void }) {
  return <SettingsForm mode="limits" onSaved={onSaved} />;
}
export function SettingsView() {
  return <SettingsForm mode="processing" />;
}
function SettingsForm({ mode, onSaved }: { mode: Mode; onSaved?: () => void }) {
  const app = useApplication(),
    load = useLoad((signal) => api('settings.read', {}, { signal }));
  const models = useLoad((signal) =>
    mode === 'assistant' ? api('models.list', {}, { signal }) : Promise.resolve([]),
  );
  if (!load.data) return <Loading error={load.error} retry={load.reload} />;
  const settings = load.data,
    operator = Boolean(app.session.user?.operator);
  return (
    <>
      {mode === 'processing' && (
        <PageHeader
          title={'Processing settings'}
          description={'Technical settings for this company. Changes apply to new jobs.'}
        />
      )}
      {mode === 'limits' && (
        <div className="section-heading">
          <div>
            <h2>Company limits</h2>
            <p>
              {operator
                ? 'You can change the budget and resources available to this company.'
                : 'You can lower limits. Ask the platform owner to raise them.'}
            </p>
          </div>
        </div>
      )}
      <Form
        protectChanges
        disabled={mode === 'assistant' && (!models.data || models.loading || Boolean(models.error))}
        key={mode + ':' + settings.revision}
        label={
          mode === 'assistant'
            ? 'Save assistant settings'
            : mode === 'limits'
              ? 'Save limits'
              : 'Save processing settings'
        }
        submit={async (f) => {
          const changes: Partial<Settings> = {};
          for (const { keys } of groups[mode])
            for (const key of keys) changes[key] = Math.round(Number(f.get(key)) * limits[key][1]);
          if (mode === 'assistant')
            Object.assign(changes, {
              prompt: text(f, 'prompt'),
              generationProfile: text(f, 'generationProfile'),
              transcriptionProfile: text(f, 'transcriptionProfile'),
            });
          if (mode === 'processing')
            Object.assign(changes, {
              ocrLanguage: text(f, 'ocrLanguage'),
              whisperLanguage: text(f, 'whisperLanguage'),
              pauseIntake: f.has('pauseIntake'),
              pauseQueue: f.has('pauseQueue'),
              pauseIndexing: f.has('pauseIndexing'),
            });
          await api('settings.save', { revision: settings.revision, settings: changes });
          load.reload();
          onSaved?.();
          app.notify('Company settings saved.');
        }}
      >
        {mode === 'assistant' && (
          <>
            <section className="panel">
              <h2>Assistant models</h2>
              {models.error && <Loading error={models.error} retry={models.reload} />}
              {!models.data && !models.error && <Loading />}
              {models.data &&
                (['generationProfile', 'transcriptionProfile'] as const).map((key) => (
                  <ModelChoice
                    key={settings.revision + ':' + key}
                    name={key}
                    value={settings[key]}
                    profiles={models.data!}
                  />
                ))}
              <p className="muted">
                Availability checks do not assess answer quality or speed. Selecting a model does
                not install it on the server.
              </p>
              {operator ? (
                <p>
                  <AdminLink to="models" tab="connections">
                    Manage connected models
                  </AdminLink>
                </p>
              ) : (
                <p className="muted">
                  The platform owner configures available models and provider keys.
                </p>
              )}
            </section>
            <details className="panel admin-details">
              <summary>Assistant behavior</summary>
              <Field
                label={'System instructions'}
                name="prompt"
                type="textarea"
                value={settings.prompt}
                required
                maxLength={32000}
                hint={
                  'Rules for all new answers in this company. Do not enter passwords or API keys.'
                }
              />
            </details>
          </>
        )}
        {groups[mode].map((group) => {
          const Container = mode === 'assistant' ? 'details' : 'section';
          return (
            <Container className="panel admin-details" key={group.title}>
              {mode === 'assistant' ? (
                <summary>Answer &amp; context settings</summary>
              ) : (
                <h2>{group.title}</h2>
              )}
              <p>{group.description}</p>
              <div className="form-grid">
                {group.keys.map((key) => (
                  <Field
                    key={key}
                    label={limits[key][0]}
                    name={key}
                    type="number"
                    value={settings[key] / limits[key][1]}
                    min={0}
                    max={
                      !operator && planKeys.includes(key)
                        ? settings[key] / limits[key][1]
                        : undefined
                    }
                    step="any"
                    required
                    hint={
                      !operator && planKeys.includes(key)
                        ? 'Only the platform owner can increase this limit.'
                        : undefined
                    }
                  />
                ))}
              </div>
              {mode === 'processing' && group.title === 'Images, audio & video' && (
                <div className="form-grid">
                  <Field
                    label={'OCR languages'}
                    name="ocrLanguage"
                    value={settings.ocrLanguage}
                    required
                    hint={'For example, eng+rus. Language packs must be installed on the server.'}
                  />
                  <Field
                    label={'Whisper speech language'}
                    name="whisperLanguage"
                    value={settings.whisperLanguage}
                    required
                    hint={'auto detects the language; en is English and ru is Russian.'}
                  />
                </div>
              )}
            </Container>
          );
        })}
        {mode === 'processing' && (
          <section className="panel">
            <h2>Pause company processing</h2>
            <p>Use during maintenance. These switches affect only the selected company.</p>
            <Check
              name="pauseIntake"
              label={'Stop accepting new jobs'}
              checked={settings.pauseIntake}
            />
            <Check name="pauseQueue" label={'Pause queued jobs'} checked={settings.pauseQueue} />
            <Check name="pauseIndexing" label={'Pause indexing'} checked={settings.pauseIndexing} />
          </section>
        )}
      </Form>
    </>
  );
}
function ModelChoice({
  name,
  value,
  profiles,
}: {
  name: 'generationProfile' | 'transcriptionProfile';
  value: string;
  profiles: ModelProfile[];
}) {
  const [selected, setSelected] = useState(value),
    profile = profiles.find((p) => p.id === selected);
  return (
    <div className="admin-model-choice">
      <label>
        {name === 'generationProfile' ? 'Answer model' : 'Recording transcription'}
        <select name={name} value={selected} onChange={(e) => setSelected(e.target.value)}>
          {selected && !profiles.some((p) => p.id === selected) && (
            <option value={selected} disabled>
              Current model is unavailable · {selected}
            </option>
          )}
          {name === 'transcriptionProfile' && <option value="">No separate transcription</option>}
          {profiles
            .filter(
              (p) => p.role === (name === 'generationProfile' ? 'generation' : 'transcription'),
            )
            .map((p) => (
              <option key={p.id} value={p.id} disabled={!p.enabled}>
                {p.name}
                {p.enabled ? '' : ' · disabled'}
              </option>
            ))}
        </select>
      </label>
      {name === 'transcriptionProfile' && (
        <p className="muted">
          Converts speech in audio and video to text. Whisper runs on the installation server;
          Google Gemini sends audio to Google through its API and counts toward the budget. Gemini
          detects and preserves the original language. Transcription is optional for searching
          original audio, and required for text search.
        </p>
      )}
      {selected && !profile && (
        <p className="warning" role="alert">
          The selected model was removed or is unavailable. Choose an allowed model; if the list is
          empty, contact the platform owner.
        </p>
      )}
      {profile && <ModelAvailability profile={profile} />}
    </div>
  );
}
