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
  maxBytes: ['Размер файла, МиБ', 1024 ** 2],
  maxPages: ['Страниц / сегментов материала', 1],
  maxTextCharacters: ['Извлечённого текста, символов', 1],
  maxChunks: ['Фрагментов документа', 1],
  maxDocuments: ['Документов', 1],
  maxQueue: ['Принятых незавершённых заданий', 1],
  answerConcurrency: ['Ответов одновременно', 1],
  indexConcurrency: ['Фоновых обработок одновременно', 1],
  storageBytes: ['Объём файлов, ГиБ', 1024 ** 3],
  monthlyBudgetMicros: ['Бюджет AI в месяц, USD', 1e6],
  maxOutputTokens: ['Максимальный ответ, токенов', 1],
  contextTokens: ['Бюджет контекста, токенов', 1],
  topK: ['Источников в ответе', 1],
  cacheSeconds: ['Хранить кеш ответов и поиска, секунд', 1],
  sessionHours: ['Длительность сессии, часов', 1],
  historyDays: ['Хранить историю, дней', 1],
  jobDays: ['Хранить задания, дней', 1],
  tempHours: ['Хранить незавершённые загрузки, часов', 1],
  logDays: ['Хранить журнал действий, дней', 1],
  backupDays: ['Хранить резервные копии, дней', 1],
  backupIntervalHours: ['Интервал копирования, часов; 0 — вручную', 1],
  ocrTimeoutSeconds: ['OCR: секунд на страницу', 1],
  ocrMemoryMB: ['OCR: память, МиБ', 1],
  whisperThreads: ['Whisper: потоков CPU', 1],
  mediaMaxSeconds: ['Длительность записи, секунд', 1],
  mediaTimeoutSeconds: ['Таймаут обработки медиа, секунд', 1],
  videoMaxFrames: ['Целевое число видеофрагментов', 1],
  mediaImageMaxSide: ['Сторона изображения, пикселей', 1],
  answerMaxImages: ['Медиафрагментов на ответ', 1],
} as const;
type NumericKey = keyof typeof limits;
type Mode = 'assistant' | 'limits' | 'processing';
const groups: Record<Mode, { title: string; description: string; keys: NumericKey[] }[]> = {
  assistant: [
    {
      title: 'Ответы и поиск',
      description: 'Применяется к новым вопросам пользователей.',
      keys: ['maxOutputTokens', 'contextTokens', 'topK', 'answerMaxImages', 'cacheSeconds'],
    },
  ],
  limits: [
    {
      title: 'Ресурсы компании',
      description: 'Генерация ответов и индексация имеют отдельные ограничения.',
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
      title: 'Документы',
      description: 'Предельный размер и объём извлекаемых данных.',
      keys: ['maxBytes', 'maxPages', 'maxTextCharacters', 'maxChunks'],
    },
    {
      title: 'Изображения, аудио и видео',
      description: 'Размеры, длительность и выделенные ресурсы обработки.',
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
      title: 'Хранение и сессии',
      description: 'Сроки хранения действуют в пределах выбранной компании.',
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
          title="Параметры обработки"
          description="Технические настройки компании. Изменения применяются к новым заданиям."
        />
      )}
      {mode === 'limits' && (
        <div className="section-heading">
          <div>
            <h2>Лимиты компании</h2>
            <p>
              {operator
                ? 'Вы можете менять бюджет и доступные компании ресурсы.'
                : 'Вы можете уменьшить лимиты. Для увеличения обратитесь к владельцу платформы.'}
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
            ? 'Сохранить настройки помощника'
            : mode === 'limits'
              ? 'Сохранить лимиты'
              : 'Сохранить параметры обработки'
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
          app.notify('Настройки компании сохранены.');
        }}
      >
        {mode === 'assistant' && (
          <>
            <section className="panel">
              <h2>Модели помощника</h2>
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
                Проверка подтверждает доступность модели; она не оценивает качество и скорость
                ответов. Выбор модели не устанавливает её на сервер.
              </p>
              {operator ? (
                <p>
                  <AdminLink to="models" tab="connections">
                    Настроить подключённые модели
                  </AdminLink>
                </p>
              ) : (
                <p className="muted">
                  Доступные модели и ключи провайдеров настраивает владелец платформы.
                </p>
              )}
            </section>
            <details className="panel admin-details">
              <summary>Поведение помощника</summary>
              <Field
                label="Системная инструкция"
                name="prompt"
                type="textarea"
                value={settings.prompt}
                required
                maxLength={32000}
                hint="Правила для всех новых ответов в этой компании. Не вводите пароли и API-ключи."
              />
            </details>
          </>
        )}
        {groups[mode].map((group) => {
          const Container = mode === 'assistant' ? 'details' : 'section';
          return (
            <Container className="panel admin-details" key={group.title}>
              {mode === 'assistant' ? (
                <summary>Параметры ответов и контекста</summary>
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
                        ? 'Увеличение доступно владельцу платформы.'
                        : undefined
                    }
                  />
                ))}
              </div>
              {mode === 'processing' && group.title === 'Изображения, аудио и видео' && (
                <div className="form-grid">
                  <Field
                    label="Языки OCR"
                    name="ocrLanguage"
                    value={settings.ocrLanguage}
                    required
                    hint="Например, eng+rus. Языковые пакеты должны быть установлены на сервере."
                  />
                  <Field
                    label="Язык речи для Whisper"
                    name="whisperLanguage"
                    value={settings.whisperLanguage}
                    required
                    hint="auto — определить автоматически, ru — русский, en — английский."
                  />
                </div>
              )}
            </Container>
          );
        })}
        {mode === 'processing' && (
          <section className="panel">
            <h2>Приостановить работу компании</h2>
            <p>
              Используйте на время обслуживания. Переключатели действуют только на выбранную
              компанию.
            </p>
            <Check
              name="pauseIntake"
              label="Не принимать новые задания"
              checked={settings.pauseIntake}
            />
            <Check
              name="pauseQueue"
              label="Не запускать задания из очереди"
              checked={settings.pauseQueue}
            />
            <Check
              name="pauseIndexing"
              label="Не запускать индексацию"
              checked={settings.pauseIndexing}
            />
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
        {name === 'generationProfile' ? 'Модель для ответов' : 'Распознавание записей'}
        <select name={name} value={selected} onChange={(e) => setSelected(e.target.value)}>
          {selected && !profiles.some((p) => p.id === selected) && (
            <option value={selected} disabled>
              Текущая модель недоступна · {selected}
            </option>
          )}
          {name === 'transcriptionProfile' && <option value="">Без отдельной расшифровки</option>}
          {profiles
            .filter(
              (p) => p.role === (name === 'generationProfile' ? 'generation' : 'transcription'),
            )
            .map((p) => (
              <option key={p.id} value={p.id} disabled={!p.enabled}>
                {p.name}
                {p.enabled ? '' : ' · выключен'}
              </option>
            ))}
        </select>
      </label>
      {name === 'transcriptionProfile' && (
        <p className="muted">
          Превращает речь из аудио и видео в текст. Whisper работает на сервере установки; Google
          Gemini отправляет звук в Google через API и учитывает расход бюджета. Gemini сохраняет
          исходный язык автоматически. Для поиска по исходному аудио расшифровка необязательна; для
          текстового поиска она нужна.
        </p>
      )}
      {selected && !profile && (
        <p className="warning" role="alert">
          Выбранная модель удалена или недоступна. Выберите разрешённую модель; если список пуст,
          обратитесь к владельцу платформы.
        </p>
      )}
      {profile && <ModelAvailability profile={profile} />}
    </div>
  );
}
