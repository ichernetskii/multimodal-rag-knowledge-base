import { useEffect, useRef, useState } from 'react';
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
  published: 'Published',
  draft: 'Draft',
  excluded: 'Excluded from search',
  archived: 'Archived',
};
export const Documents = observer(function Documents() {
  const app = useApplication(),
    modal = useModal(),
    [query, setQuery] = useState(''),
    [question, setQuestion] = useState(''),
    [sort, setSort] = useState<'name' | 'updated' | 'state'>('updated'),
    [state, setState] = useState<DocumentRecord['state'] | ''>(''),
    [page, setPage] = useState(1),
    [collection, setCollection] = useState(''),
    [selected, setSelected] = useState<Record<string, number>>({}),
    [hits, setHits] = useState<SourceData[]>(),
    [searching, setSearching] = useState(false),
    [searchError, setSearchError] = useState(''),
    q = useDebouncedValue(query);
  const activeSearch = useRef<AbortController | null>(null);
  useEffect(() => () => activeSearch.current?.abort(), []);
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
  useEffect(() => {
    activeSearch.current?.abort();
    setSearching(false);
    setHits(undefined);
    setSearchError('');
  }, [collection]);
  useEffect(() => {
    setSelected({});
  }, [collection, q, state]);
  const count = Object.keys(selected).length;
  async function bulk(operation: ActionInputs['documents.bulk']['operation']) {
    await api('documents.bulk', { ids: Object.keys(selected), revisions: selected, operation });
    setSelected({});
    modal(null);
    load.reload();
  }
  const available =
    load.data?.items.filter((d) => canEditDocument(d, app.session.user, app.bases.items)) ?? [];
  const editable = app.bases.items.some((base) => app.bases.canEdit(base));
  return (
    <div className="materials-page">
      <PageHeader
        eyebrow={'KNOWLEDGE BASE'}
        title={'Materials'}
        description={
          editable
            ? 'Upload files, review processing, and publish. User questions use only authorized, published materials.'
            : app.session.user?.role === 'admin'
              ? 'Create a knowledge base under Knowledge bases & access, then upload materials.'
              : 'Read published materials you can access and find information. Ask a knowledge base editor to add or correct materials.'
        }
        actions={
          editable && (
            <Button
              className="primary"
              onClick={() => modal(<Upload collection={collection} after={load.reload} />)}
            >
              + Upload documents
            </Button>
          )
        }
      />
      {app.session.user?.role === 'editor' && editable && (
        <details className="panel compact-panel">
          <summary>Manage knowledge base names</summary>
          <div className="actions">
            {app.bases.items
              .filter((c) => app.bases.canEdit(c))
              .map((c) => (
                <Button
                  key={c.id}
                  onClick={() =>
                    modal(
                      <>
                        <h2>Knowledge base name</h2>
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
                          <Field label={'Name'} name="name" value={c.name} required />
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
            <span>Find by name</span>
            <input
              type="search"
              placeholder={'Material name…'}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
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
        </div>
        <div className="filter-bar secondary">
          <Select
            label={'Sort'}
            name="doc-sort"
            value={sort}
            options={[
              ['updated', 'Newest first'],
              ['name', 'By name'],
              ['state', 'By status'],
            ]}
            onChange={(value) => {
              setSort(value as typeof sort);
              setPage(1);
            }}
          />
          <Select
            label={'Status'}
            name="doc-state"
            options={[['', 'All statuses'], ...Object.entries(stateNames)]}
            onChange={(value) => {
              setState(value as typeof state);
              setPage(1);
            }}
          />
          <span className="muted">{quantity(load.data?.total ?? 0, 'document', 'documents')}</span>
          <Button onClick={load.reload}>Refresh</Button>
        </div>
        {count > 0 && (
          <div className="selection-bar">
            <strong>Selected: {count}</strong>
            <div className="actions">
              <Button onClick={() => bulk('archive')}>Archive</Button>
              <Button onClick={() => bulk('exclude')}>Exclude from search</Button>
              <Button
                className="text-danger"
                onClick={() =>
                  modal(
                    <>
                      <h2>Delete permanently {quantity(count, 'document', 'documents')}?</h2>
                      <p>
                        Originals, versions, and derived data will be deleted. Answers using them
                        will be hidden.
                      </p>
                      <Button className="danger" onClick={() => bulk('delete')}>
                        Delete documents
                      </Button>
                    </>,
                  )
                }
              >
                Delete
              </Button>
              <Button onClick={() => setSelected({})}>Clear selection</Button>
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
                head={['Selection', 'Document', 'Knowledge base', 'Status', 'Actions']}
                rowKeys={load.data.items.map((d) => d.id)}
                empty={'No documents found. Upload files or change your search filters.'}
                rows={load.data.items.map((d) => [
                  canEditDocument(d, app.session.user, app.bases.items) ? (
                    <input
                      type="checkbox"
                      aria-label={'Select ' + d.name}
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
                        {quantity(d.versionCount, 'version', 'versions')} ·{' '}
                        {d.updated ? date(d.updated) : 'Processing'}
                      </small>
                    </span>
                  </div>,
                  d.conversation
                    ? 'Private conversation'
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
                          ? 'Version review required'
                          : statuses[d.processing.status]}
                        {d.processing.paused ? ' · paused' : ''}
                        {d.processing.error
                          ? ' · ' + (d.processing.message || d.processing.error)
                          : ''}
                      </small>
                    )}
                  </>,
                  <div className="actions compact">
                    <Button onClick={() => modal(<DocumentView id={d.id} after={load.reload} />)}>
                      {d.processing?.reviewRequired &&
                      canEditDocument(d, app.session.user, app.bases.items)
                        ? 'Review & publish'
                        : 'Open'}
                    </Button>
                    {canEditDocument(d, app.session.user, app.bases.items) && (
                      <Button onClick={() => modal(<EditDocument doc={d} after={load.reload} />)}>
                        Edit
                      </Button>
                    )}
                  </div>,
                ])}
              />
              <div className="table-footer">
                <label className="check">
                  <input
                    type="checkbox"
                    aria-label={'Select all available documents on this page'}
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
                  Select page
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
      <section className="panel material-content-search">
        <h2>Search knowledge base content</h2>
        <p className="muted">
          Search published materials in the selected knowledge base by words and meaning. No AI
          answer is generated; a remote search model may use the company budget.
        </p>
        <label>
          Search for
          <input
            type="search"
            value={question}
            maxLength={4000}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={'Phrase, question, or code'}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                document.getElementById('document-fulltext')?.click();
              }
            }}
          />
        </label>
        <Button
          id="document-fulltext"
          disabled={searching || !question.trim()}
          onClick={async () => {
            activeSearch.current?.abort();
            const controller = new AbortController();
            activeSearch.current = controller;
            setSearching(true);
            setSearchError('');
            try {
              const hits = await api(
                'search',
                { question, scope: { collection } },
                { signal: controller.signal },
              );
              if (!controller.signal.aborted) setHits(hits);
            } catch (error) {
              if (!controller.signal.aborted)
                setSearchError(error instanceof Error ? error.message : 'Search failed');
            } finally {
              if (activeSearch.current === controller) setSearching(false);
            }
          }}
        >
          {searching ? 'Searching…' : 'Find passages'}
        </Button>
        {searching && (
          <Button
            onClick={() => {
              activeSearch.current?.abort();
              setSearching(false);
            }}
          >
            Stop search
          </Button>
        )}
      </section>
      {searchError && <Loading error={searchError} />}{' '}
      {hits && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Content matches</h2>
              <p>Exact-word and semantic search without answer generation.</p>
            </div>
            <Button onClick={() => setHits(undefined)}>Close results</Button>
          </div>
          {hits.length ? (
            hits.map((source) => (
              <article className="search-hit" key={source.chunk}>
                <Button onClick={() => modal(<Source source={source} />)}>
                  {source.name} <span className="muted">· p. {source.page}</span>
                </Button>
                <small>{source.section}</small>
                <p>{source.text.slice(0, 500)}</p>
              </article>
            ))
          ) : (
            <p className="empty-inline">No relevant sections found.</p>
          )}
        </section>
      )}
    </div>
  );
});
