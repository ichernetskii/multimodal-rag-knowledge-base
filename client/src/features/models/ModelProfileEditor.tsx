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
    app.session.tenants.find((tenant) => tenant.id === app.session.user?.tenant)?.name ??
    'Компания';
  const changeProvider = (next: AIProvider) =>
    setDraft({ ...createProfile(next), id: profile.id, revision: profile.revision });
  const changeRole = (role: ModelProfile['role']) =>
    setDraft({ ...createProfile(provider, role), id: profile.id, revision: profile.revision });
  return (
    <>
      <PageHeader
        title={draft.revision ? 'Изменить AI-подключение' : 'Новое AI-подключение'}
        description={
          'Каталог моделей компании «' +
          company +
          '». Эти параметры меняет только владелец платформы.'
        }
        actions={
          <Button
            onClick={() => {
              if (app.unsaved.confirmDiscard('page')) cancel();
            }}
          >
            ← К подключениям
          </Button>
        }
      />
      <section className="panel">
        <Form
          protectChanges
          key={draft.id + ':' + draft.revision + ':' + draft.provider + ':' + draft.role}
          disabled={needsCredential(provider) && (loading || Boolean(error))}
          label="Сохранить профиль"
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
          <h2>Основные параметры</h2>
          <Field label="Название профиля" name="name" value={draft.name} required />
          <label>
            Поставщик
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
            Задача
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
          <Field label="Модель" name="model" value={draft.model} required />
          <p className="muted">
            {provider === 'whisper'
              ? 'Whisper small встроен в сервер: внешнего адреса и API-ключа нет. Язык и потоки CPU задаются в обработке компании.'
              : provider === 'ollama'
                ? 'Укажите адрес сервера Ollama и имя уже загруженной модели. У локальной модели тоже есть контекст, размер входа, таймаут и параллельность. Сохранение профиля не устанавливает веса.'
                : 'Укажите модель, адрес API и ключ поставщика. Для Google-расшифровки выберите задачу распознавания, входы «Текст» и «Аудио», например gemini-3.8-flash.'}
          </p>
          <Field
            label="Адрес сервера модели (endpoint)"
            name="endpoint"
            value={draft.endpoint}
            readOnly={provider === 'whisper'}
          />
          {needsCredential(provider) ? (
            <label>
              API-ключ
              <select
                key={provider}
                name="secretRef"
                aria-label="API-ключ"
                aria-describedby="model-credential-hint"
                defaultValue={draft.provider === provider ? draft.secretRef : ''}
              >
                <option value="">Не выбран</option>
                {draft.provider === provider &&
                  draft.secretRef &&
                  !credentials?.some((k) => k.id === draft.secretRef) && (
                    <option value={draft.secretRef} disabled>
                      {draft.secretRef} · ключ ещё не добавлен
                    </option>
                  )}
                {credentials
                  ?.filter((k) => k.provider === provider)
                  .map((k) => (
                    <option key={k.id} value={k.id} disabled={!k.enabled}>
                      {k.label} · {k.id}
                      {k.enabled ? '' : ' · отключён'}
                    </option>
                  ))}
              </select>
              <small id="model-credential-hint">
                Выберите общий ключ поставщика. Само значение здесь не показывается.
              </small>
              <AdminLink to="credentials">
                Добавить или заменить ключ в реестре платформы →
              </AdminLink>
            </label>
          ) : (
            <>
              <input type="hidden" name="secretRef" value="" />
              <p className="muted">Этот поставщик не требует внешнего API-ключа.</p>
            </>
          )}
          {error && <Loading error={error} retry={reload} />}
          <p className="muted">
            Отметьте входы, которые поддерживает именно эта модель. Настройка не добавляет модели
            новые возможности; сервер проверяет ограничения адаптера и доступность.
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
            <summary>Контекст, размеры и ограничения вызовов</summary>
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
              <summary>Тариф внешнего API</summary>
              <p className="muted">
                Для внешнего API укажите актуальные цены поставщика. Система использует их для
                бюджета компании.
              </p>
              <p className="muted">
                Каждая ставка — USD за миллион входных токенов, а не за файл или секунду. PDF
                учитывается по токенам текста и изображений. Если Google не сообщает разбивку,
                неизвестные токены учитываются по максимальной ставке возможных модальностей и
                помечаются как оценка.
              </p>
              <div className="form-grid">
                {(['text', 'image', 'audio', 'video'] as const).map((m) => (
                  <Field
                    key={m}
                    label={`${modalityNames[m]}: USD за миллион входных токенов`}
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
                label="Выход: USD за миллион токенов"
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
                Локальные вызовы используют ресурсы сервера; счёт поставщика API отсутствует.
              </p>
            </>
          )}
          <Check name="enabled" label="Разрешить использование" checked={draft.enabled} />
          <Check
            name="cache"
            label="Использовать поддерживаемое кеширование контекста"
            checked={draft.cache}
          />
          <Button
            onClick={() => {
              if (app.unsaved.confirmDiscard('page')) cancel();
            }}
          >
            Закрыть форму
          </Button>
        </Form>
      </section>
    </>
  );
}
