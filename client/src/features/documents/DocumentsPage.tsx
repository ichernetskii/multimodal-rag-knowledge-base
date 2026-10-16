import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { api } from '../../shared/api/client';
import type {
  ActionInputs,
  DocumentRecord,
  Source as SourceData,
} from '../../shared/api/contracts.generated';
import { terminal } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { text } from '../../shared/lib/form-data';
import { date, quantity } from '../../shared/lib/format';
import { useLoad, useModal, useDebouncedValue, usePolling } from '../../shared/lib/hooks';
import { canEditDocument } from '../../shared/lib/permissions';
import { Button } from '../../shared/ui/Button';
import { Field, Form, Select } from '../../shared/ui/Form';
import { Badge, Loading, PageHeader } from '../../shared/ui/Feedback';
import { Table, Pagination } from '../../shared/ui/DataTable';
import { statuses } from '../jobs/job-status';
import { KnowledgeBaseSelector } from '../knowledge-bases/KnowledgeBaseSelector';
import { DocumentView } from './DocumentDialog';
import { EditDocument } from './EditDocumentDialog';
import { Source } from './SourceDialog';
import { Upload } from './UploadDialog';
const stateNames: Record<DocumentRecord['state'], string> = {
  published: 'Опубликован',
  draft: 'Черновик',
  excluded: 'Вне поиска',
  archived: 'В архиве',
};
export const Documents = observer(function Documents() {
  const app = useApplication(),
    modal = useModal(),
    [query, setQuery] = useState(''),
    [sort, setSort] = useState<'name' | 'updated' | 'state'>('updated'),
    [state, setState] = useState<DocumentRecord['state'] | ''>(''),
    [page, setPage] = useState(1),
    [collection, setCollection] = useState(''),
    [selected, setSelected] = useState<Record<string, number>>({}),
    [hits, setHits] = useState<SourceData[]>(),
    [searching, setSearching] = useState(false),
    [searchError, setSearchError] = useState(''),
    q = useDebouncedValue(query);
  const load = useLoad(
    (signal) =>
      api(
        'documents.list',
        { query: q, sort, state, scope: { collection }, page, pageSize: 25 },
        { signal },
      ),
    [q, sort, state, collection, page, app.jobs.documentEpoch],
  );
  useEffect(() => {
    for (const doc of load.data?.items ?? [])
      if (doc.processing && !terminal.has(doc.processing.status)) {
        if (!app.jobs.items.some((j) => j.id === doc.processing!.id))
          void app.execute(async () => {
            const job = await api('jobs.read', { id: doc.processing!.id });
            app.jobs.upsert(job);
            app.jobs.watch(job);
          });
        else app.jobs.watch(app.jobs.items.find((job) => job.id === doc.processing!.id)!);
      }
  }, [load.data]);
  usePolling(
    load.reload,
    5000,
    load.data?.items.some((doc) => doc.processing && !terminal.has(doc.processing.status)) ?? false,
  );
  const count = Object.keys(selected).length;
  async function bulk(operation: ActionInputs['documents.bulk']['operation']) {
    await api('documents.bulk', { ids: Object.keys(selected), revisions: selected, operation });
    setSelected({});
    modal(null);
    load.reload();
  }
  const available =
    load.data?.items.filter((d) => canEditDocument(d, app.session.user, app.bases.items)) ?? [];
  return (
    <div className="page-content">
      <PageHeader
        eyebrow="БАЗА ЗНАНИЙ"
        title="Документы"
        description="Ищите по библиотеке, открывайте исходные разделы и управляйте версиями документов."
        actions={
          app.bases.items.some((c) => app.bases.canEdit(c)) && (
            <Button
              className="primary"
              onClick={() => modal(<Upload collection={collection} after={load.reload} />)}
            >
              + Загрузить документы
            </Button>
          )
        }
      />
      {app.session.user?.role === 'editor' && (
        <details className="panel compact-panel">
          <summary>Управление названиями баз</summary>
          <div className="actions">
            {app.bases.items
              .filter((c) => app.bases.canEdit(c))
              .map((c) => (
                <Button
                  key={c.id}
                  onClick={() =>
                    modal(
                      <>
                        <h2>Название базы</h2>
                        <Form
                          submit={async (f) => {
                            await api('collections.rename', {
                              id: c.id,
                              revision: c.revision,
                              name: text(f, 'name'),
                            });
                            await app.bases.refresh();
                            modal(null);
                          }}
                        >
                          <Field label="Название" name="name" value={c.name} required />
                        </Form>
                      </>,
                    )
                  }
                >
                  {c.name}
                </Button>
              ))}
          </div>
        </details>
      )}
      <section className="panel">
        <div className="filter-bar">
          <label className="search-field">
            <span>Название или текст документа</span>
            <input
              type="search"
              placeholder="Например, инструкция или код ошибки…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  document.getElementById('document-fulltext')?.click();
                }
              }}
            />
          </label>
          <KnowledgeBaseSelector
            value={collection}
            onChange={(id) => {
              setCollection(id);
              setPage(1);
              setSelected({});
            }}
          />
          <Button
            id="document-fulltext"
            disabled={searching || !query.trim()}
            onClick={async () => {
              setSearching(true);
              setSearchError('');
              try {
                setHits(await api('search', { question: query, scope: { collection } }));
              } catch (error) {
                setSearchError(error instanceof Error ? error.message : 'Ошибка поиска');
              } finally {
                setSearching(false);
              }
            }}
          >
            {searching ? 'Поиск…' : 'Найти по тексту'}
          </Button>
        </div>
        <div className="filter-bar secondary">
          <Select
            label="Сортировка"
            name="doc-sort"
            value={sort}
            options={[
              ['updated', 'Сначала новые'],
              ['name', 'По названию'],
              ['state', 'По состоянию'],
            ]}
            onChange={(value) => {
              setSort(value as typeof sort);
              setPage(1);
            }}
          />
          <Select
            label="Состояние"
            name="doc-state"
            options={[['', 'Все состояния'], ...Object.entries(stateNames)]}
            onChange={(value) => {
              setState(value as typeof state);
              setPage(1);
            }}
          />
          <span className="muted">
            {quantity(load.data?.total ?? 0, 'документ', 'документа', 'документов')}
          </span>
          <Button onClick={load.reload}>Обновить</Button>
        </div>
        {count > 0 && (
          <div className="selection-bar">
            <strong>Выбрано: {count}</strong>
            <div className="actions">
              <Button onClick={() => bulk('archive')}>В архив</Button>
              <Button onClick={() => bulk('exclude')}>Исключить из поиска</Button>
              <Button
                className="text-danger"
                onClick={() =>
                  modal(
                    <>
                      <h2>
                        Окончательно удалить{' '}
                        {quantity(count, 'документ', 'документа', 'документов')}?
                      </h2>
                      <p>
                        Будут удалены оригиналы, версии и производные данные. Использованные ответы
                        будут скрыты.
                      </p>
                      <Button className="danger" onClick={() => bulk('delete')}>
                        Удалить документы
                      </Button>
                    </>,
                  )
                }
              >
                Удалить
              </Button>
              <Button onClick={() => setSelected({})}>Снять выбор</Button>
            </div>
          </div>
        )}
        {load.error && <Loading error={load.error} retry={load.reload} />}
        <div aria-busy={load.loading}>
          {!load.data ? (
            <Loading />
          ) : (
            <>
              <Table
                head={['Выбор', 'Документ', 'База знаний', 'Состояние', 'Действия']}
                rowKeys={load.data.items.map((d) => d.id)}
                empty="Документы не найдены. Загрузите файлы или измените условия поиска."
                rows={load.data.items.map((d) => [
                  canEditDocument(d, app.session.user, app.bases.items) ? (
                    <input
                      type="checkbox"
                      aria-label={'Выбрать ' + d.name}
                      checked={d.id in selected}
                      onChange={(e) =>
                        setSelected((previous) => {
                          const next = { ...previous };
                          if (e.target.checked) next[d.id] = d.revision;
                          else delete next[d.id];
                          return next;
                        })
                      }
                    />
                  ) : null,
                  <div className="document-cell">
                    <span className="file-icon">
                      {d.name.split('.').at(-1)?.toUpperCase().slice(0, 4) || 'DOC'}
                    </span>
                    <span>
                      <strong>{d.name}</strong>
                      <small>
                        {d.versionCount} версий · {d.updated ? date(d.updated) : 'Обработка'}
                      </small>
                    </span>
                  </div>,
                  d.conversation
                    ? 'Личный диалог'
                    : (app.bases.items.find((c) => c.id === d.collection)?.name ?? '—'),
                  <>
                    <Badge
                      tone={
                        d.state === 'published'
                          ? 'success'
                          : d.state === 'draft'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {stateNames[d.state]}
                    </Badge>
                    {d.processing && (
                      <small className={d.processing.error ? 'error' : 'muted'}>
                        {d.processing.reviewRequired
                          ? 'Нужна проверка версии'
                          : statuses[d.processing.status]}
                        {d.processing.paused ? ' · пауза' : ''}
                        {d.processing.error ? ' · ' + d.processing.error : ''}
                      </small>
                    )}
                  </>,
                  <div className="actions compact">
                    <Button onClick={() => modal(<DocumentView id={d.id} after={load.reload} />)}>
                      {d.processing?.reviewRequired &&
                      canEditDocument(d, app.session.user, app.bases.items)
                        ? 'Проверить и опубликовать'
                        : 'Открыть'}
                    </Button>
                    {canEditDocument(d, app.session.user, app.bases.items) && (
                      <Button onClick={() => modal(<EditDocument doc={d} after={load.reload} />)}>
                        Изменить
                      </Button>
                    )}
                  </div>,
                ])}
              />
              <div className="table-footer">
                <label className="check">
                  <input
                    type="checkbox"
                    aria-label="Выбрать все доступные документы страницы"
                    disabled={!available.length}
                    checked={!!available.length && available.every((d) => d.id in selected)}
                    onChange={(e) => {
                      if (e.target.checked)
                        setSelected((previous) => ({
                          ...previous,
                          ...Object.fromEntries(available.map((d) => [d.id, d.revision])),
                        }));
                      else
                        setSelected((previous) =>
                          Object.fromEntries(
                            Object.entries(previous).filter(
                              ([id]) => !available.some((d) => d.id === id),
                            ),
                          ),
                        );
                    }}
                  />
                  Выбрать страницу
                </label>
                <Pagination
                  page={page}
                  pageSize={load.data.pageSize}
                  total={load.data.total}
                  onChange={setPage}
                  loading={load.loading}
                />
              </div>
            </>
          )}
        </div>
      </section>
      {searchError && <Loading error={searchError} />}{' '}
      {hits && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Совпадения в содержимом</h2>
              <p>Поиск по точным словам и смыслу без генерации ответа.</p>
            </div>
            <Button onClick={() => setHits(undefined)}>Закрыть результаты</Button>
          </div>
          {hits.length ? (
            hits.map((source) => (
              <article className="search-hit" key={source.chunk}>
                <Button onClick={() => modal(<Source source={source} />)}>
                  {source.name} <span className="muted">· стр. {source.page}</span>
                </Button>
                <small>{source.section}</small>
                <p>{source.text.slice(0, 500)}</p>
              </article>
            ))
          ) : (
            <p className="empty-inline">Подходящие разделы не найдены.</p>
          )}
        </section>
      )}
    </div>
  );
});
