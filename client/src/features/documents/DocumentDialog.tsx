import { useEffect, useState } from 'react';
import { api, tenantUrl } from '../../shared/api/client';
import { terminal, type DocumentDetails } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { date, quantity } from '../../shared/lib/format';
import { text } from '../../shared/lib/form-data';
import { useLoad, useModal, usePolling } from '../../shared/lib/hooks';
import { canEditDocument } from '../../shared/lib/permissions';
import { Button } from '../../shared/ui/Button';
import { Form } from '../../shared/ui/Form';
import { Badge, Loading } from '../../shared/ui/Feedback';
import { MediaPreview } from './MediaPreview';
import { Compare } from './CompareVersionsDialog';
import { ReplaceDocument } from './ReplaceVersionDialog';
import { DocumentFind, HighlightedText } from './DocumentFind';
import { warningNames } from './material-warnings';
import { statuses } from '../jobs/job-status';
const versionStates = {
  ready: 'Проиндексирована',
  review: 'Нужна проверка',
  pending: 'Обработка',
} as const;
const windowSize = 12000;
function PageText({
  data,
  page,
  offset,
  query,
  editing,
  setEditing,
  navigate,
  corrected,
}: {
  data: DocumentDetails;
  page: number;
  offset: number;
  query: string;
  editing: boolean;
  setEditing: (value: boolean) => void;
  navigate: (page: number, offset: number) => void;
  corrected: () => void;
}) {
  const app = useApplication();
  const load = useLoad(
    (signal) =>
      api(
        'documents.page',
        {
          id: data.document.id,
          version: data.version.id,
          page,
          offset,
          limit: windowSize,
        },
        { signal },
      ),
    [data.document.id, data.version.id, page, offset],
  );
  if (!load.data || load.loading) return <Loading error={load.error} retry={load.reload} />;
  if (load.error) return <Loading error={load.error} retry={load.reload} />;
  const part = load.data;
  return (
    <>
      <div className="document-page-meta">
        <Badge tone={part.method === 'ocr' ? 'warning' : 'neutral'}>
          {
            {
              text: 'Текст материала',
              ocr: 'Текст после OCR',
              vision: 'Визуальный материал',
              speech: 'Аудиоматериал',
            }[part.method]
          }
        </Badge>
        {part.warnings.map((warning) => (
          <Badge key={warning} tone="warning">
            {warningNames[warning] ?? warning}
          </Badge>
        ))}
      </div>
      <div className={'document-reader' + (part.media ? ' document-reader-media' : '')}>
        {part.media && (
          <section className="document-original">
            <h3>Оригинал</h3>
            <MediaPreview
              document={data.document.id}
              version={data.version.id}
              media={part.media}
            />
          </section>
        )}
        <section className="document-processed">
          <h3>{part.media ? 'Сохранённый текст обработки' : 'Чтение материала'}</h3>
          {part.preparedText && (
            <p className="muted">
              {part.preparedText.kind === 'transcript' ? 'Расшифровку' : 'Описание'} подготовила
              модель {part.preparedText.model} · {date(part.preparedText.created)}.
              {part.warnings.includes('USER_CORRECTED') ? ' Текст исправлен редактором.' : ''} Смена
              модели поиска этот текст не пересоздаёт.
            </p>
          )}
          {part.totalCharacters > windowSize && (
            <p className="muted" role="status">
              Символы {part.offset + 1}–{part.nextOffset} из{' '}
              {part.totalCharacters.toLocaleString('ru-RU')}. Большой текст загружается частями.
            </p>
          )}
          {editing ? (
            <Form
              protectChanges
              key={data.version.id + ':' + part.number + ':' + part.offset}
              label="Сохранить исправление"
              submit={async (form) => {
                await api('documents.correct', {
                  id: data.document.id,
                  revision: data.document.revision,
                  version: data.version.id,
                  page: part.number,
                  text: text(form, 'correctedText'),
                  range: { start: part.offset, end: part.nextOffset },
                });
                setEditing(false);
                corrected();
                load.reload();
                app.notify('Исправление сохранено. Проверьте текст перед публикацией.');
              }}
            >
              <label>
                {part.totalCharacters > part.text.length
                  ? 'Исправить этот фрагмент'
                  : 'Исправленный текст'}
                <textarea
                  name="correctedText"
                  defaultValue={part.text}
                  rows={14}
                  required={part.totalCharacters <= part.text.length}
                />
              </label>
              <p className="muted">Оригинал и остальная часть текста сохранятся.</p>
              <Button
                onClick={() => {
                  if (app.unsaved.confirmDiscard('dialog')) setEditing(false);
                }}
              >
                Отмена
              </Button>
            </Form>
          ) : (
            <HighlightedText
              text={
                part.text ||
                'Содержательный текст ещё не создан. Мультимодальный поиск может использовать само медиа.'
              }
              query={query}
              selected={Boolean(query)}
            />
          )}
          {part.totalCharacters > windowSize && (
            <div className="actions document-text-pager">
              <Button
                disabled={part.offset === 0 || editing}
                onClick={() => navigate(page, Math.max(0, part.offset - windowSize))}
              >
                ← Предыдущий фрагмент текста
              </Button>
              <Button
                disabled={part.nextOffset >= part.totalCharacters || editing}
                onClick={() => navigate(page, part.nextOffset)}
              >
                Следующий фрагмент текста →
              </Button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
export function DocumentView({ id, after }: { id: string; after: () => void }) {
  const app = useApplication(),
    modal = useModal();
  const [version, setVersion] = useState(''),
    [page, setPage] = useState(1),
    [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(false),
    [acknowledged, setAcknowledged] = useState(false);
  const [findOpen, setFindOpen] = useState(false),
    [highlight, setHighlight] = useState('');
  const load = useLoad(
    (signal) => api('documents.read', { id, ...(version ? { version } : {}) }, { signal }),
    [id, version],
  );
  usePolling(
    load.reload,
    3000,
    Boolean(load.data?.processing && !terminal.has(load.data.processing.status)),
  );
  useEffect(() => setAcknowledged(false), [load.data?.document.revision]);
  useEffect(() => {
    const find = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    document.addEventListener('keydown', find);
    return () => document.removeEventListener('keydown', find);
  }, []);
  if (!load.data) return <Loading error={load.error} retry={load.reload} />;
  const data = load.data,
    v = data.version;
  const canEdit = canEditDocument(data.document, app.session.user, app.bases.items);
  const currentPage = data.pages.some((part) => part.number === page)
    ? page
    : (data.pages[0]?.number ?? 1);
  const review = data.pages.filter((part) => part.warnings.length || part.method === 'ocr');
  const navigate = (number: number, at = 0) => {
    if (!app.unsaved.confirmDiscard('dialog')) return;
    setPage(number);
    setOffset(at);
    setEditing(false);
  };
  const processing = data.processing;
  return (
    <div className="document-view">
      <p className="eyebrow">
        МАТЕРИАЛ · {quantity(data.versions.length, 'версия', 'версии', 'версий')}
      </p>
      <h2>{data.document.name}</h2>
      {load.error && <Loading error={load.error} retry={load.reload} />}
      <div className="document-version-bar">
        <label>
          Версия материала
          <select
            value={v.id}
            disabled={editing}
            onChange={(event) => {
              setVersion(event.target.value);
              navigate(1);
              setAcknowledged(false);
              setHighlight('');
            }}
          >
            {data.versions.map((item) => (
              <option key={item.id} value={item.id}>
                {date(item.created)} · {versionStates[item.state]}
                {item.id === data.document.activeVersion ? ' · используется в поиске' : ''}
              </option>
            ))}
          </select>
        </label>
        <a
          className="button-link"
          href={tenantUrl(`/api/documents/${id}?version=${v.id}`)}
          target="_blank"
          rel="noopener"
        >
          Открыть оригинал ↗
        </a>
        <a
          className="button-link"
          href={tenantUrl(`/api/documents/${id}?version=${v.id}&download=1`)}
        >
          Скачать оригинал
        </a>
        {data.versions.length > 1 && (
          <Button disabled={editing} onClick={() => modal(<Compare data={data} />)}>
            Сравнить версии
          </Button>
        )}
        {canEdit && (
          <Button
            disabled={editing}
            onClick={() => modal(<ReplaceDocument doc={data.document} after={after} />)}
          >
            Новая версия
          </Button>
        )}
      </div>
      {processing && !terminal.has(processing.status) && (
        <p className="info-callout" role="status">
          {processing.message || statuses[processing.status]}. Статус обновляется автоматически.
        </p>
      )}
      {processing?.error && (
        <div className="inline-error" role="alert">
          <strong>Обработка не завершена</strong>
          <p>{processing.message || processing.error}</p>
          <small>
            Код: {processing.error} · ID: {processing.diagnostic}
          </small>
          {canEdit && (
            <Button
              onClick={async () => {
                const job = await api('jobs.retry', { id: processing.id });
                app.jobs.upsert(job);
                app.jobs.watch(job);
                load.reload();
                after();
              }}
            >
              Повторить обработку
            </Button>
          )}
        </div>
      )}
      {data.pages.length > 0 ? (
        <>
          <div className="document-page-bar">
            <label>
              Страница / сегмент
              <select
                aria-label="Страница материала"
                value={currentPage}
                disabled={editing}
                onChange={(event) => navigate(Number(event.target.value))}
              >
                {data.pages.map((part) => (
                  <option key={part.number} value={part.number}>
                    {part.number} из {data.pages.length}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={editing}
              onClick={() => {
                setFindOpen(!findOpen);
                if (findOpen) setHighlight('');
              }}
            >
              {findOpen ? 'Закрыть поиск в тексте' : 'Найти в этом документе'}
            </Button>
          </div>
          <DocumentFind
            key={v.id}
            id={id}
            version={v.id}
            open={findOpen}
            select={(match, query) => {
              navigate(match.page, Math.max(0, match.offset - 300));
              setHighlight(query);
            }}
          />
          {review.length > 0 && canEdit && (
            <details className="form-section">
              <summary>Страницы и сегменты для проверки · {review.length}</summary>
              <div className="review-pages">
                {review.map((part) => (
                  <Button
                    key={part.number}
                    disabled={editing}
                    onClick={() => navigate(part.number)}
                  >
                    {part.number}
                    {!part.characters ? ' · нет текста' : ''}
                  </Button>
                ))}
              </div>
            </details>
          )}
          <PageText
            key={v.id + ':' + currentPage + ':' + offset}
            data={data}
            page={currentPage}
            offset={offset}
            query={highlight}
            editing={editing}
            setEditing={setEditing}
            navigate={navigate}
            corrected={() => {
              setAcknowledged(false);
              load.reload();
              after();
            }}
          />
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
          {canEdit && v.state === 'ready' && (
            <Form
              label="Создать версию для исправлений"
              disabled={data.versions.some((item) => item.state !== 'ready')}
              submit={async () => {
                const job = await api('documents.revise', {
                  id,
                  revision: data.document.revision,
                  version: v.id,
                });
                app.jobs.upsert(job);
                app.jobs.watch(job);
                setVersion('');
                navigate(1);
                setAcknowledged(false);
                load.reload();
                after();
                app.notify(
                  'Создаётся версия для исправлений. Опубликованный материал остаётся в поиске.',
                );
              }}
            >
              <p>
                Нашли ошибку в тексте, описании или расшифровке? Создайте отдельную версию и
                исправьте обработку. Оригинал и медиафрагменты сохранятся без повторного
                распознавания. Поиск переключится после проверки и публикации.
              </p>
              {data.versions.some((item) => item.state !== 'ready') && (
                <p className="muted">
                  Уже есть версия для обработки или проверки. Выберите её в списке версий и
                  завершите проверку.
                </p>
              )}
            </Form>
          )}
        </>
      ) : (
        <p className="empty-inline">Текст и предпросмотр появятся после обработки материала.</p>
      )}
      {canEdit && data.pages.length > 0 && (
        <section className="document-publication">
          <h3>{v.state === 'ready' ? 'Поиск по этой версии' : 'Проверить и опубликовать'}</h3>
          {v.state === 'review' && (
            <>
              <p>
                Сверьте текст с оригиналом. Ошибки OCR, описания и расшифровки можно исправить выше.
                Если ошибочен сам файл, загрузите новую версию.
              </p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={editing}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                Я проверил результат обработки по оригиналу
              </label>
            </>
          )}
          <Button
            className="primary"
            disabled={editing || v.state === 'pending' || (v.state === 'review' && !acknowledged)}
            onClick={async () => {
              const job = await api('documents.publish', {
                id,
                revision: data.document.revision,
                version: v.id,
                acknowledge: true,
                activate: true,
              });
              app.jobs.upsert(job);
              app.jobs.watch(job);
              modal(null);
              after();
              app.notify('Публикация и индексация поставлены в очередь.');
            }}
          >
            {v.state === 'ready'
              ? v.id === data.document.activeVersion
                ? 'Переиндексировать'
                : 'Использовать эту версию в поиске'
              : 'Опубликовать и включить в поиск'}
          </Button>
        </section>
      )}
    </div>
  );
}
