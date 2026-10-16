import { useState } from 'react';
import { api } from '../../shared/api/client';
import type { ModelProfile, Modality, AIProvider } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { useLoad } from '../../shared/lib/hooks';
import { text } from '../../shared/lib/form-data';
import { Button } from '../../shared/ui/Button';
import { Form, Field, Check } from '../../shared/ui/Form';
import { PageHeader, Loading } from '../../shared/ui/Feedback';
import { ModelAvailability } from './ModelAvailability';
import { CredentialsPanel } from './CredentialsPanel';
const providerNames = {
  google: 'Google Gemini',
  anthropic: 'Anthropic Claude',
  ollama: 'Ollama · локальные модели',
  'openai-compatible': 'Совместимый с OpenAI API сервер',
  whisper: 'Whisper · локальное распознавание',
  test: 'TEST AI · проверка разработки',
} as const;
const taskNames = {
  generation: 'Ответы и понимание материалов',
  embedding: 'Поиск по базе знаний',
  transcription: 'Распознавание речи',
} as const;
const modalityNames = {
  text: 'Текст',
  image: 'Изображения',
  audio: 'Аудио',
  video: 'Видео',
  pdf: 'PDF',
} as const;
const numeric = {
  dimensions: 'Размерность embeddings',
  contextTokens: 'Контекст, токенов',
  maxOutputTokens: 'Максимальный ответ, токенов',
  maxBytes: 'Лимит медиа, байт',
  maxSeconds: 'Лимит фрагмента, секунд',
  concurrency: 'Одновременных вызовов',
  requestsPerMinute: 'Запросов в минуту',
  tokensPerMinute: 'Токенов в минуту',
  timeoutMs: 'Таймаут, мс',
} as const;
export function Connections() {
  const app = useApplication(),
    models = useLoad((signal) => api('models.list', {}, { signal })),
    keys = useLoad((signal) => api('secrets.list', {}, { signal }));
  const [editing, setEditing] = useState<ModelProfile | null>(null),
    [availabilityRefresh, setAvailabilityRefresh] = useState(0),
    [provider, setProvider] = useState<AIProvider>('google');
  const editProfile = (p: ModelProfile) => {
    setProvider(p.provider);
    setEditing(p);
  };
  const refreshKeys = () => {
    keys.reload();
    setAvailabilityRefresh((n) => n + 1);
  };
  const operator = Boolean(app.session.user?.operator);
  const company =
    app.session.tenants.find((t) => t.id === app.session.user?.tenant)?.name ?? 'компании';
  if (editing)
    return (
      <>
        <PageHeader
          title={editing.revision ? 'Изменить AI-подключение' : 'Новое AI-подключение'}
          description={
            'Каталог моделей компании «' +
            company +
            '». Эти параметры меняет только владелец платформы.'
          }
          actions={<Button onClick={() => setEditing(null)}>← К подключениям</Button>}
        />
        <section className="panel">
          <Form
            key={editing.id + ':' + editing.revision}
            disabled={keys.loading || Boolean(keys.error)}
            label="Сохранить профиль"
            submit={async (f) => {
              const profile: ModelProfile = {
                ...editing,
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
              setEditing(null);
              models.reload();
              keys.reload();
            }}
          >
            <h2>Основные параметры</h2>
            <Field label="Название профиля" name="name" value={editing.name} required />
            <label>
              Поставщик
              <select
                name="provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value as AIProvider)}
                disabled={!operator}
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
            {!operator && <input type="hidden" name="provider" value={editing.provider} />}
            <label>
              Задача
              <select name="role" defaultValue={editing.role} disabled={!operator}>
                {['generation', 'embedding', 'transcription'].map((p) => (
                  <option key={p} value={p}>
                    {taskNames[p as ModelProfile['role']]}
                  </option>
                ))}
              </select>
            </label>
            {!operator && <input type="hidden" name="role" value={editing.role} />}
            <Field label="Модель" name="model" value={editing.model} required />
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
              value={editing.endpoint}
              readOnly={!operator}
            />
            {['google', 'anthropic', 'openai-compatible'].includes(provider) ? (
              <label>
                API-ключ
                <select
                  key={provider}
                  name="secretRef"
                  aria-label="API-ключ"
                  aria-describedby="model-credential-hint"
                  defaultValue={editing.provider === provider ? editing.secretRef : ''}
                >
                  <option value="">Не выбран</option>
                  {editing.provider === provider &&
                    editing.secretRef &&
                    !keys.data?.some((k) => k.id === editing.secretRef) && (
                      <option value={editing.secretRef} disabled>
                        {editing.secretRef} · ключ ещё не добавлен
                      </option>
                    )}
                  {keys.data
                    ?.filter((k) => k.provider === provider)
                    .map((k) => (
                      <option key={k.id} value={k.id} disabled={!k.enabled}>
                        {k.label} · {k.id}
                        {k.enabled ? '' : ' · отключён'}
                      </option>
                    ))}
                </select>
                <small id="model-credential-hint">
                  Ключи добавляются в реестре платформы на предыдущем экране. Само значение здесь не
                  показывается.
                </small>
              </label>
            ) : (
              <>
                <input type="hidden" name="secretRef" value="" />
                <p className="muted">Этот поставщик не требует внешнего API-ключа.</p>
              </>
            )}
            {keys.error && <Loading error={keys.error} retry={keys.reload} />}
            <div className="form-grid">
              {(['text', 'image', 'audio', 'video', 'pdf'] as const).map((m) => (
                <Check
                  key={m}
                  name="input"
                  label={modalityNames[m]}
                  value={m}
                  checked={editing.input.includes(m)}
                />
              ))}
            </div>
            <details className="admin-details">
              <summary>Контекст, размеры и ограничения вызовов</summary>
              <div className="form-grid">
                {(Object.keys(numeric) as (keyof typeof numeric)[]).map((key) => (
                  <Field
                    key={key}
                    label={numeric[key]}
                    name={key}
                    value={editing[key]}
                    type="number"
                    min={0}
                    required
                  />
                ))}
              </div>
            </details>
            <h2>Тариф и использование</h2>
            <p className="muted">
              Для внешнего API укажите актуальные цены поставщика. Система использует их для бюджета
              компании.
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
                  value={editing.inputMicrosPerMillion[m] / 1e6}
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
              value={editing.outputMicrosPerMillion / 1e6}
              type="number"
              step="any"
              min={0}
            />
            <Check name="enabled" label="Разрешить использование" checked={editing.enabled} />
            <Check
              name="cache"
              label="Использовать поддерживаемое кеширование контекста"
              checked={editing.cache}
            />
            <Button onClick={() => setEditing(null)}>Закрыть форму</Button>
          </Form>
        </section>
      </>
    );
  return (
    <>
      <PageHeader
        title="AI-подключения и ключи"
        description={
          'API-ключи общие для всей платформы. Ниже — подключения моделей компании «' +
          company +
          '». Администратор компании выбирает их в разделе «Помощник и модели».'
        }
        actions={
          <>
            <Button className="primary" onClick={() => editProfile(createProfile())}>
              + Подключить модель
            </Button>
            <Button
              onClick={() =>
                editProfile({
                  ...createProfile(),
                  name: 'Google Gemini · расшифровка записей',
                  role: 'transcription',
                  input: ['text', 'audio'],
                  maxOutputTokens: 2048,
                  inputMicrosPerMillion: { text: 750000, image: 0, audio: 750000, video: 0 },
                  outputMicrosPerMillion: 3750000,
                  cache: false,
                })
              }
            >
              + Google-расшифровка
            </Button>
          </>
        }
      />
      <CredentialsPanel
        credentials={keys.data ?? []}
        loading={keys.loading}
        error={keys.error}
        reload={keys.reload}
        onChanged={refreshKeys}
      />
      <section className="panel">
        <h2>Профили моделей</h2>
        <p>
          Для внешних моделей выберите ключ из реестра платформы. Администраторы компаний не видят
          значения ключей и не могут менять подключения. Профиль TEST AI предназначен для разработки
          и проверок.
        </p>
        <p>
          Разрешение профиля не устанавливает модель и не запускает Ollama. Доступность проверяется
          с сервера автоматически при открытии раздела; проверка не генерирует платный ответ.
        </p>
        <Button onClick={() => setAvailabilityRefresh((n) => n + 1)}>Проверить все модели</Button>
        {models.error && <Loading error={models.error} retry={models.reload} />}
        <div className="model-profiles">
          {models.data?.map((p) => (
            <article className="model-profile" key={p.id} aria-label={p.name}>
              <h3>{p.name}</h3>
              <p>
                <code>{p.model}</code> · {p.enabled ? 'Разрешён' : 'Выключен'}
              </p>
              <p>
                {providerNames[p.provider]} · {taskNames[p.role]}
                <br />
                Вход: {p.input.map((m) => modalityNames[m]).join(', ')}
              </p>
              <ModelAvailability profile={p} refresh={availabilityRefresh} />
              <div className="model-profile-actions">
                {operator && <Button onClick={() => editProfile(p)}>Изменить</Button>}
                {operator && (
                  <Button
                    onClick={() =>
                      editProfile({
                        ...p,
                        id: crypto.randomUUID(),
                        revision: 0,
                        name: p.name + ' — копия',
                        enabled: false,
                      })
                    }
                  >
                    Копировать
                  </Button>
                )}
                {operator && (
                  <Button
                    onClick={async () => {
                      await api('models.delete', { id: p.id, revision: p.revision });
                      models.reload();
                    }}
                  >
                    Удалить
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
function createProfile(): ModelProfile {
  return {
    id: crypto.randomUUID(),
    revision: 0,
    name: 'Google Gemini',
    provider: 'google',
    role: 'generation',
    model: 'gemini-3.8-flash',
    endpoint: 'https://generativelanguage.googleapis.com',
    secretRef: 'google',
    input: ['text', 'image', 'audio', 'video', 'pdf'],
    dimensions: 0,
    contextTokens: 16000,
    maxOutputTokens: 1024,
    maxBytes: 20 * 1024 * 1024,
    maxSeconds: 60,
    concurrency: 1,
    requestsPerMinute: 60,
    tokensPerMinute: 100000,
    inputMicrosPerMillion: { text: 0, image: 0, audio: 0, video: 0 },
    outputMicrosPerMillion: 0,
    timeoutMs: 300000,
    cache: true,
    enabled: false,
  };
}
