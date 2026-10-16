import { tenantUrl } from '../../shared/api/client';
import { useState } from 'react';
import { api } from '../../shared/api/client';
import { useApplication } from '../../shared/lib/application-context';
import { date } from '../../shared/lib/format';
import { useLoad, useModal, usePolling } from '../../shared/lib/hooks';
import { canEditDocument } from '../../shared/lib/permissions';
import { Button } from '../../shared/ui/Button';
import { Form } from '../../shared/ui/Form';
import { text } from '../../shared/lib/form-data';
import { Badge, Loading } from '../../shared/ui/Feedback';
import { MediaPreview } from './MediaPreview';
import { Compare } from './CompareVersionsDialog';
import { ReplaceDocument } from './ReplaceVersionDialog';
const versionStates = {
  ready: 'Проиндексирована',
  review: 'Нужна проверка',
  pending: 'Обработка',
} as const;
const warningNames: Record<string, string> = {
  VISION_REVIEW_REQUIRED: 'Проверьте описание и надписи на фото',
  SAMPLED_FRAMES_REVIEW_REQUIRED: 'Проверьте кадр; между кадрами возможны пропуски',
  SPEECH_REVIEW_REQUIRED: 'Проверьте расшифровку речи',
  OCR_REVIEW_REQUIRED: 'Проверьте распознанный текст',
  OCR_LOW_CONFIDENCE: 'Низкая уверенность распознавания',
  OCR_UNAVAILABLE_OR_FAILED: 'OCR не извлёк текст',
  NO_TEXT: 'Текст не извлечён',
  LOW_TEXT_DENSITY: 'Мало извлечённого текста',
  TABLE_REVIEW_REQUIRED: 'Проверьте таблицу',
  MACHINE_TRANSCRIPT_REVIEW_REQUIRED: 'Проверьте машинную расшифровку',
  MACHINE_DESCRIPTION_REVIEW_REQUIRED: 'Проверьте машинное описание',
  USER_CORRECTED: 'Текст исправлен редактором',
  AUTO_TEXT_REVIEW_REQUIRED: 'Текст подготовлен для нового поиска — сверьте с оригиналом',
};
export function DocumentView({ id, after }: { id: string; after: () => void }) {
  const app = useApplication(),
    modal = useModal(),
    [version, setVersion] = useState(''),
    [page, setPage] = useState(1),
    [editing, setEditing] = useState(false),
    [acknowledged, setAcknowledged] = useState(false),
    [query, setQuery] = useState('');
  const load = useLoad(
    (signal) => api('documents.read', { id, ...(version ? { version } : {}) }, { signal }),
    [id, version],
  );
  usePolling(load.reload, 3000, load.data?.version.state === 'pending');
  if (!load.data) return <Loading error={load.error} retry={load.reload} />;
  const d = load.data,
    v = d.version,
    p = v.pages[page - 1],
    canEdit = canEditDocument(d.document, app.session.user, app.bases.items),
    review = v.pages.filter((page) => page.warnings.length || page.method === 'ocr');
  return (
    <>
      <p className="eyebrow">ДОКУМЕНТ · {d.versions.length} ВЕРСИЙ</p>
      <h2>{d.document.name}</h2>
      <label className="field">
        <span>Версия документа</span>
        <select
          value={v.id}
          onChange={(e) => {
            setVersion(e.target.value);
            setPage(1);
            setEditing(false);
            setAcknowledged(false);
          }}
        >
          {d.versions.map((item) => (
            <option key={item.id} value={item.id}>
              {date(item.created)} · {versionStates[item.state]}
              {item.id === d.document.activeVersion ? ' · используется в поиске' : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="actions">
        <a
          className="button-link"
          href={tenantUrl(`/api/documents/${id}?version=${v.id}&download=1`)}
        >
          Скачать оригинал
        </a>
        {d.versions.length > 1 && (
          <Button onClick={() => modal(<Compare data={d} />)}>Сравнить версии</Button>
        )}
        {canEdit && (
          <>
            <Button onClick={() => modal(<ReplaceDocument doc={d.document} after={after} />)}>
              Новая версия
            </Button>
            {v.id !== d.document.activeVersion && v.state === 'ready' && (
              <Button
                onClick={async () => {
                  await api('documents.restore', {
                    id,
                    revision: d.document.revision,
                    version: v.id,
                  });
                  after();
                  load.reload();
                  app.notify('Выбранная версия используется в поиске.');
                }}
              >
                Использовать эту версию
              </Button>
            )}
            {v.pages.length > 0 && (
              <Button
                className={v.state === 'review' ? 'primary' : ''}
                disabled={v.state === 'pending' || (v.state === 'review' && !acknowledged)}
                onClick={async () => {
                  const job = await api('documents.publish', {
                    id,
                    revision: d.document.revision,
                    version: v.id,
                    acknowledge: true,
                    activate: true,
                  });
                  app.jobs.upsert(job);
                  app.jobs.watch(job);
                  modal(null);
                  after();
                  app.notify('Индексация поставлена в очередь.');
                }}
              >
                {v.state === 'ready' ? 'Переиндексировать' : 'Опубликовать и включить в поиск'}
              </Button>
            )}
          </>
        )}
      </div>
      {v.state === 'review' && (
        <div className="warning callout">
          <strong>Сверьте результат обработки с оригиналом.</strong>
          <p>
            Ошибки OCR, описания или расшифровки можно исправить ниже. Оригинальный файл при этом не
            меняется.
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            Я проверил результат обработки по оригиналу
          </label>
        </div>
      )}
      {review.length > 0 && (
        <section className="form-section">
          <h3>Страницы для проверки · {review.length}</h3>
          <div className="review-pages">
            {review.map((item) => (
              <Button
                key={item.number}
                className={item.number === page ? 'primary' : ''}
                onClick={() => setPage(item.number)}
              >
                Стр. {item.number}
                {!item.text.trim() ? ' · пустая' : ''}
              </Button>
            ))}
          </div>
        </section>
      )}
      <div className="document-page-bar">
        <h3>Текст материала и результаты обработки</h3>
        <select
          aria-label="Страница документа"
          value={page}
          onChange={(e) => {
            setPage(Number(e.target.value));
            setEditing(false);
          }}
        >
          {v.pages.map((item) => (
            <option key={item.number} value={item.number}>
              Страница {item.number} из {v.pages.length}
            </option>
          ))}
        </select>
      </div>
      {v.pages.length > 0 && (
        <section className="document-find">
          <label>
            Найти текст в материале
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Слово, фраза или код"
            />
          </label>
          {query.trim() && (
            <div aria-live="polite">
              {v.pages.filter((item) =>
                item.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
              ).length === 0 ? (
                <p>Совпадений нет.</p>
              ) : (
                <>
                  <p>
                    Найдено страниц:{' '}
                    {
                      v.pages.filter((item) =>
                        item.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
                      ).length
                    }
                  </p>
                  {v.pages
                    .filter((item) =>
                      item.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
                    )
                    .slice(0, 50)
                    .map((item) => {
                      const at = item.text
                        .toLocaleLowerCase()
                        .indexOf(query.trim().toLocaleLowerCase());
                      return (
                        <Button
                          key={item.number}
                          onClick={() => {
                            setPage(item.number);
                            setEditing(false);
                          }}
                        >
                          Стр. {item.number}: …
                          {item.text.slice(Math.max(0, at - 30), at + query.length + 60)}…
                        </Button>
                      );
                    })}
                </>
              )}
            </div>
          )}
        </section>
      )}
      {p ? (
        <>
          <div className="actions">
            <Badge tone={p.method === 'ocr' ? 'warning' : 'neutral'}>
              {
                {
                  text: 'Текстовый слой',
                  ocr: 'Распознана OCR',
                  vision: 'Визуальный материал',
                  speech: 'Аудиоматериал',
                }[p.method]
              }
            </Badge>
            {p.warnings.map((warning) => (
              <Badge key={warning} tone="warning">
                {warningNames[warning] ?? warning}
              </Badge>
            ))}
          </div>
          <MediaPreview document={id} version={v.id} media={p.media} />
          {p.preparedText && (
            <p className="muted">
              {p.preparedText.kind === 'transcript' ? 'Расшифровку' : 'Описание'} подготовила модель{' '}
              {p.preparedText.model}. Текст сохраняется при смене поисковой модели.
            </p>
          )}
          {editing ? (
            <Form
              key={v.id + ':' + p.number}
              label="Сохранить исправление"
              submit={async (f) => {
                await api('documents.correct', {
                  id,
                  revision: d.document.revision,
                  version: v.id,
                  page: p.number,
                  text: text(f, 'correctedText'),
                });
                setEditing(false);
                setAcknowledged(false);
                load.reload();
                after();
                app.notify('Исправление сохранено. Проверьте текст ещё раз перед публикацией.');
              }}
            >
              <label>
                Исправленный текст
                <textarea name="correctedText" defaultValue={p.text} rows={14} required />
              </label>
              <Button onClick={() => setEditing(false)}>Отмена</Button>
            </Form>
          ) : (
            <div className="document-reader-text">
              {p.text ||
                'Содержательный текст не создан. Для мультимодального поиска он может быть не нужен.'}
            </div>
          )}
          {canEdit && v.state === 'review' && !editing && (
            <Button
              onClick={() => {
                setEditing(true);
                setAcknowledged(false);
              }}
            >
              Исправить текст обработки
            </Button>
          )}
        </>
      ) : (
        <p className="empty-inline">Текст появится после обработки документа.</p>
      )}
    </>
  );
}
