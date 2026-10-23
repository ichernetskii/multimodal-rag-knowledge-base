import { useState } from 'react';
import { api } from '../../shared/api/client';
import type { Collection, Group } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { quantity } from '../../shared/lib/format';
import { text } from '../../shared/lib/form-data';
import { useLoad, useModal, useDebouncedValue } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Field, Form } from '../../shared/ui/Form';
import { Badge, EmptyState, Loading, PageHeader } from '../../shared/ui/Feedback';
import { Pagination } from '../../shared/ui/DataTable';
import { Upload } from '../documents/UploadDialog';
function AccessEditor({
  collection,
  groups,
  done,
}: {
  collection?: Collection;
  groups: Group[];
  done: () => void;
}) {
  const [grants, setGrants] = useState<Collection['grants']>(collection?.grants ?? []),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(1),
    q = useDebouncedValue(query);
  const users = useLoad(
    (signal) => api('users.list', { query: q, page, pageSize: 10 }, { signal }),
    [q, page],
  );
  const selectedIds =
    collection?.grants.filter((g) => !g.subject.startsWith('group:')).map((g) => g.subject) ?? [];
  const names = useLoad(
    async (signal) => {
      const results = [];
      for (let at = 0; at < selectedIds.length; at += 100)
        results.push(
          ...(
            await api(
              'users.list',
              { ids: selectedIds.slice(at, at + 100), pageSize: 100 },
              { signal },
            )
          ).items,
        );
      return results;
    },
    [collection?.id],
  );
  const label = (id: string) =>
    id.startsWith('group:')
      ? 'Group: ' + (groups.find((g) => g.id === id.slice(6))?.name ?? id.slice(6))
      : (users.data?.items.find((u) => u.id === id)?.login ??
        names.data?.find((u) => u.id === id)?.login ??
        id);
  const change = (subject: string, access: string) =>
    setGrants((previous) => {
      const next = previous.filter((grant) => grant.subject !== subject);
      if (access === 'read' || access === 'edit') next.push({ subject, access });
      return next;
    });
  const row = (id: string, name: string) => (
    <label key={id} className="access-row">
      <span>{name}</span>
      <select
        aria-label={'Access: ' + name}
        value={grants.find((g) => g.subject === id)?.access ?? ''}
        onChange={(e) => change(id, e.target.value)}
      >
        <option value="">No access</option>
        <option value="read">Read</option>
        <option value="edit">Edit</option>
      </select>
    </label>
  );
  return (
    <>
      <p className="eyebrow">KNOWLEDGE BASE</p>
      <h2>{collection ? 'Name & access' : 'New knowledge base'}</h2>
      <Form
        protectChanges
        submit={async (f) => {
          await api('collections.save', {
            ...(collection ? { id: collection.id, revision: collection.revision } : {}),
            name: text(f, 'name'),
            grants,
          });
          done();
        }}
      >
        <Field label={'Name'} name="name" value={collection?.name} required />
        <section className="form-section">
          <h3>Assigned access</h3>
          <p className="muted">
            Administrators can access all shared knowledge bases. Permission changes take effect
            immediately on the server and in caches.
          </p>
          {grants.length ? (
            grants.map((g) => row(g.subject, label(g.subject)))
          ) : (
            <p className="empty-inline">No access has been assigned yet.</p>
          )}
        </section>
        <section className="form-section">
          <h3>Add people &amp; groups</h3>
          <label className="field">
            <span>Find people</span>
            <input
              type="search"
              placeholder={'Username…'}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </label>
          {users.error && <Loading error={users.error} retry={users.reload} />}
          <div className="subject-list">
            {users.data?.items
              .filter((u) => !grants.some((g) => g.subject === u.id))
              .map((u) => row(u.id, u.login))}
          </div>
          {users.data && (
            <Pagination
              page={page}
              pageSize={10}
              total={users.data.total}
              onChange={setPage}
              loading={users.loading}
            />
          )}
          <h4>Groups</h4>
          {groups
            .filter((g) => !grants.some((grant) => grant.subject === 'group:' + g.id))
            .map((g) => row('group:' + g.id, g.name))}
          {!groups.length && <p className="muted">Create groups in the Users section.</p>}
        </section>
      </Form>
      {collection && (
        <Button
          onClick={async () => {
            if (!window.confirm('Delete this knowledge base and all its documents?')) return;
            await api('collections.delete', { id: collection.id, revision: collection.revision });
            done();
          }}
        >
          Delete knowledge base
        </Button>
      )}
    </>
  );
}
export function Collections() {
  const app = useApplication(),
    modal = useModal(),
    [query, setQuery] = useState('');
  const load = useLoad(async (signal) => {
    const [collections, groups] = await Promise.all([
      api('collections.list', {}, { signal }),
      api('groups.list', {}, { signal }),
    ]);
    return { collections, groups };
  });
  const edit = (collection?: Collection) =>
    modal(
      <AccessEditor
        collection={collection}
        groups={load.data?.groups ?? []}
        done={() => {
          modal(null);
          load.reload();
          void app.execute(() => app.bases.refresh());
          app.notify('Knowledge base and permissions saved.');
        }}
      />,
    );
  const collections = load.data?.collections.filter((c) =>
    c.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        eyebrow={'ORGANIZE DOCUMENTS'}
        title={'Knowledge bases & access'}
        description={'Group documents by purpose and manage access for people and groups.'}
        actions={
          <Button className="primary" onClick={() => edit()}>
            + Knowledge base
          </Button>
        }
      />
      <div className="filter-bar standalone">
        <label className="search-field">
          <span className="sr-only">Find a knowledge base</span>
          <input
            type="search"
            placeholder={'Find a knowledge base…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className="muted">
          {quantity(load.data?.collections.length ?? 0, 'knowledge base', 'knowledge bases')}
        </span>
      </div>
      {load.error && <Loading error={load.error} retry={load.reload} />}{' '}
      {!load.data ? (
        <Loading />
      ) : collections?.length ? (
        <div className="collection-grid">
          {collections.map((c) => (
            <section key={c.id} className="panel collection-card">
              <div className="collection-card-top">
                <span className="collection-symbol">▤</span>
                <Badge>{quantity(c.documentCount, 'document', 'documents')}</Badge>
              </div>
              <h2>{c.name}</h2>
              <p>
                {c.grants.length
                  ? quantity(c.grants.length, 'access grant', 'access grants')
                  : 'Administrators only'}
              </p>
              <div className="collection-access">
                {c.grants.slice(0, 4).map((g) => (
                  <span
                    className="access-avatar"
                    key={g.subject}
                    title={g.subject.startsWith('group:') ? 'Group' : 'Member'}
                  >
                    {g.subject.startsWith('group:') ? 'G' : 'U'}
                  </span>
                ))}
                {c.grants.length > 4 && <span>+{c.grants.length - 4}</span>}
              </div>
              <div className="card-footer">
                <Button onClick={() => edit(c)}>Name &amp; permissions</Button>
                <Button onClick={() => modal(<Upload collection={c.id} after={load.reload} />)}>
                  Upload
                </Button>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <section className="panel">
          <EmptyState
            title={query ? 'No matches' : 'Create your first knowledge base'}
            description={
              query
                ? 'Try another name.'
                : 'Assign access and upload documents for search and answers.'
            }
          >
            <Button className="primary" onClick={() => edit()}>
              + Knowledge base
            </Button>
          </EmptyState>
        </section>
      )}
      <div className="info-callout">
        <strong>Private attachments are stored separately</strong>
        <p>
          Documents attached to a conversation are private to its owner and are not published in
          these knowledge bases.
        </p>
      </div>
    </>
  );
}
