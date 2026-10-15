import { useState } from 'react';
import { api } from '../../shared/api/client';
import { useApplication } from '../../shared/lib/application-context';
import { date } from '../../shared/lib/format';
import { useLoad, useModal } from '../../shared/lib/hooks';
import { canEditDocument } from '../../shared/lib/permissions';
import { Button } from '../../shared/ui/Button';
import { Badge, Loading } from '../../shared/ui/Feedback';
import { Compare } from './CompareVersionsDialog';
import { ReplaceDocument } from './ReplaceVersionDialog';
const versionStates = {
  ready: 'Проиндексирована',
  review: 'Нужна проверка',
  pending: 'Обработка',
} as const;
const warningNames: Record<string, string> = {
  OCR_REVIEW_REQUIRED: 'Проверьте распознанный текст',
  OCR_LOW_CONFIDENCE: 'Низкая уверенность распознавания',
  OCR_UNAVAILABLE_OR_FAILED: 'OCR не извлёк текст',
  NO_TEXT: 'Текст не извлечён',
  LOW_TEXT_DENSITY: 'Мало извлечённого текста',
  TABLE_REVIEW_REQUIRED: 'Проверьте таблицу',
};
export function DocumentView({ id, after }: { id: string; after: () => void }) {
  const app = useApplication(),
    modal = useModal(),
    [version, setVersion] = useState(''),
    [page, setPage] = useState(1);
  const load = useLoad(
    (signal) => api('documents.read', { id, ...(version ? { version } : {}) }, { signal }),
    [id, version],
  );
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
        <a className="button-link" href={`/api/documents/${id}?version=${v.id}&download=1`}>
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
                {v.state === 'ready' ? 'Переиндексировать' : 'Текст проверен · опубликовать'}
              </Button>
            )}
          </>
        )}
      </div>
      {v.state === 'review' && (
        <div className="warning callout">
          <strong>Проверьте извлечённый текст перед публикацией.</strong>
          <p>
            Пустые страницы и ошибки OCR блокируют публикацию. Для них загрузите исправленный
            документ.
          </p>
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
        <h3>Извлечённый текст</h3>
        <select
          aria-label="Страница документа"
          value={page}
          onChange={(e) => setPage(Number(e.target.value))}
        >
          {v.pages.map((item) => (
            <option key={item.number} value={item.number}>
              Страница {item.number} из {v.pages.length}
            </option>
          ))}
        </select>
      </div>
      {p ? (
        <>
          <div className="actions">
            <Badge tone={p.method === 'ocr' ? 'warning' : 'neutral'}>
              {p.method === 'ocr' ? 'Распознана OCR' : 'Текстовый слой'}
            </Badge>
            {p.warnings.map((warning) => (
              <Badge key={warning} tone="warning">
                {warningNames[warning] ?? warning}
              </Badge>
            ))}
          </div>
          <pre className="document-page-text">{p.text || 'Текст не извлечён.'}</pre>
        </>
      ) : (
        <p className="empty-inline">Текст появится после обработки документа.</p>
      )}
    </>
  );
}
