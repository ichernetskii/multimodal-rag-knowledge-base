import { api } from '../../shared/api/client';
import type { Settings } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { text } from '../../shared/lib/form-data';
import { useLoad } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Field, Form } from '../../shared/ui/Form';
import { Loading, PageHeader } from '../../shared/ui/Feedback';
const fields = {
  maxBytes: { label: 'Размер файла, МиБ', scale: 1024 ** 2, min: 1 / 1024, max: 100 },
  maxPages: { label: 'Страниц в одном PDF', min: 1, max: 2000 },
  maxTextCharacters: {
    label: 'Извлечённого текста, млн символов',
    scale: 1_000_000,
    min: 0.001,
    max: 32,
  },
  maxChunks: { label: 'Фрагментов в одном документе', min: 1, max: 50_000 },
  maxDocuments: { label: 'Документов в библиотеке', min: 1, max: 100_000 },
  maxQueue: { label: 'Заданий в очереди', min: 1, max: 10_000 },
  minFreeBytes: {
    label: 'Резерв свободного диска, МиБ',
    scale: 1024 ** 2,
    min: 0,
    max: 1e12 / 1024 ** 2,
  },
  sessionHours: { label: 'Длительность сессии, часов', min: 1, max: 720 },
  historyDays: { label: 'История диалогов, дней', min: 1, max: 36500 },
  jobDays: { label: 'Завершённые задания, дней', min: 1, max: 36500 },
  tempHours: { label: 'Временные файлы, часов', min: 1, max: 8760 },
  logDays: { label: 'Технические журналы, дней', min: 1, max: 36500 },
  eventLimit: { label: 'SSE-событий на задание', min: 16, max: 1024 },
  topK: { label: 'Источников в контексте', min: 1, max: 20 },
  ocrTimeoutSeconds: { label: 'OCR: таймаут страницы, секунд', min: 5, max: 600 },
  ocrMemoryMB: { label: 'OCR: память процесса, МиБ', min: 256, max: 16384 },
} satisfies Partial<
  Record<keyof Settings, { label: string; scale?: number; min: number; max: number }>
>;
type FieldName = keyof typeof fields;
export function SettingsView() {
  const app = useApplication(),
    load = useLoad((signal) => api('settings.read', {}, { signal }));
  const s = load.data;
  const renderFields = (keys: FieldName[]) => (
    <div className="form-grid">
      {keys.map((key) => {
        const config: { label: string; scale?: number; min: number; max: number } = fields[key];
        return (
          <Field
            key={key}
            label={config.label}
            name={key}
            type="number"
            min={config.min}
            max={config.max}
            step={config.scale ? 'any' : 1}
            value={s![key] / (config.scale ?? 1)}
            required
          />
        );
      })}
    </div>
  );
  return (
    <>
      <PageHeader
        eyebrow="КОНФИГУРАЦИЯ"
        title="Настройки"
        description="Модели, обработка документов и ограничения текущей установки."
        actions={<Button onClick={load.reload}>Перечитать настройки</Button>}
      />
      {load.error && <Loading error={load.error} retry={load.reload} />}{' '}
      {s ? (
        <Form
          key={s.revision}
          label="Сохранить настройки"
          className="settings-form"
          submit={async (f) => {
            const settings: Partial<Settings> = {
              model: text(f, 'model'),
              prompt: text(f, 'prompt'),
              ocrLanguage: text(f, 'ocrLanguage'),
            };
            for (const key of Object.keys(fields) as FieldName[]) {
              const config: { label: string; scale?: number } = fields[key];
              settings[key] = Math.round(Number(f.get(key)) * (config.scale ?? 1));
            }
            await api('settings.save', { revision: s.revision, settings });
            load.reload();
            app.notify('Настройки сохранены. Проверьте результат на контрольных вопросах.');
          }}
        >
          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>Ответы и поиск</h2>
                <p>
                  Модель Ollama должна быть подготовлена локально. Изменения применяются к новым
                  заданиям.
                </p>
              </div>
            </div>
            <Field
              label="Модель генерации Ollama"
              name="model"
              value={s.model}
              required
              placeholder="Название установленной модели"
            />
            <Field
              label="Системная инструкция"
              name="prompt"
              type="textarea"
              value={s.prompt}
              required
              hint="Определяет поведение модели. Источники и история передаются как недоверенные данные."
            />
            {renderFields(['topK'])}
            <div className="info-callout">
              <p>
                Модель embedding и её параметры задаются в конфигурации сервера. После их смены
                документы необходимо переиндексировать.
              </p>
            </div>
          </section>
          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>Документы и OCR</h2>
                <p>OCR запускается в фоне только для страниц без пригодного текста.</p>
              </div>
            </div>
            {renderFields([
              'maxBytes',
              'maxPages',
              'maxDocuments',
              'maxTextCharacters',
              'maxChunks',
              'ocrTimeoutSeconds',
              'ocrMemoryMB',
            ])}
            <Field
              label="Языки Tesseract"
              name="ocrLanguage"
              value={s.ocrLanguage}
              required
              hint="Например, rus+eng. Нужны локально установленные языковые пакеты. Ограничение памяти применяется на Linux."
            />
          </section>
          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>Ресурсы и сессии</h2>
                <p>Предельная очередь, запас места и срок действия входа.</p>
              </div>
            </div>
            {renderFields(['maxQueue', 'minFreeBytes', 'sessionHours', 'eventLimit'])}
          </section>
          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>Сроки хранения</h2>
                <p>
                  Очистка не затрагивает данные, нужные незавершённым заданиям. Полное содержимое
                  вопросов и документов не пишется в технические журналы.
                </p>
              </div>
            </div>
            {renderFields(['historyDays', 'jobDays', 'tempHours', 'logDays'])}
          </section>
          <div className="settings-footer">
            <span>
              Каталог данных <code>{s.dataDir}</code>
            </span>
            <Button onClick={() => app.navigation.navigate('admin', 'backups')}>
              Настроить резервные копии →
            </Button>
          </div>
        </Form>
      ) : (
        !load.error && <Loading />
      )}
    </>
  );
}
