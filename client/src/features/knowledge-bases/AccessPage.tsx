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
      ? 'Группа: ' + (groups.find((g) => g.id === id.slice(6))?.name ?? id.slice(6))
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
        aria-label={'Доступ: ' + name}
        value={grants.find((g) => g.subject === id)?.access ?? ''}
        onChange={(e) => change(id, e.target.value)}
      >
        <option value="">Нет доступа</option>
        <option value="read">Просмотр</option>
        <option value="edit">Редактирование</option>
      </select>
    </label>
  );
  return (
    <>
      <p className="eyebrow">БАЗА ЗНАНИЙ</p>
      <h2>{collection ? 'Название и доступ' : 'Новая база знаний'}</h2>
      <Form
        submit={async (f) => {
          await api('collections.save', {
            ...(collection ? { id: collection.id, revision: collection.revision } : {}),
            name: text(f, 'name'),
            grants,
          });
          done();
        }}
      >
        <Field label="Название" name="name" value={collection?.name} required />
        <section className="form-section">
          <h3>Назначенный доступ</h3>
          <p className="muted">
            Администраторы имеют доступ ко всем общим базам. Изменения прав сразу учитываются
            сервером и кешем.
          </p>
          {grants.length ? (
            grants.map((g) => row(g.subject, label(g.subject)))
          ) : (
            <p className="empty-inline">Доступ ещё никому не назначен.</p>
          )}
        </section>
        <section className="form-section">
          <h3>Добавить пользователей и группы</h3>
          <label className="field">
            <span>Поиск пользователей</span>
            <input
              type="search"
              placeholder="Логин…"
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
          <h4>Группы</h4>
          {groups
            .filter((g) => !grants.some((grant) => grant.subject === 'group:' + g.id))
            .map((g) => row('group:' + g.id, g.name))}
          {!groups.length && <p className="muted">Создайте группы в разделе «Пользователи».</p>}
        </section>
      </Form>
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
          app.notify('База знаний и права доступа сохранены.');
        }}
      />,
    );
  const collections = load.data?.collections.filter((c) =>
    c.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        eyebrow="ОРГАНИЗАЦИЯ ДОКУМЕНТОВ"
        title="Базы и доступ"
        description="Объединяйте документы по задачам и управляйте доступом пользователей и групп."
        actions={
          <Button className="primary" onClick={() => edit()}>
            + База знаний
          </Button>
        }
      />
      <div className="filter-bar standalone">
        <label className="search-field">
          <span className="sr-only">Найти базу знаний</span>
          <input
            type="search"
            placeholder="Найти базу знаний…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className="muted">
          {quantity(load.data?.collections.length ?? 0, 'база', 'базы', 'баз')}
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
                <Badge>{quantity(c.documentCount, 'документ', 'документа', 'документов')}</Badge>
              </div>
              <h2>{c.name}</h2>
              <p>
                {c.grants.length
                  ? quantity(
                      c.grants.length,
                      'назначение доступа',
                      'назначения доступа',
                      'назначений доступа',
                    )
                  : 'Доступ только у администраторов'}
              </p>
              <div className="collection-access">
                {c.grants.slice(0, 4).map((g) => (
                  <span
                    className="access-avatar"
                    key={g.subject}
                    title={g.subject.startsWith('group:') ? 'Группа' : 'Пользователь'}
                  >
                    {g.subject.startsWith('group:') ? 'Г' : 'П'}
                  </span>
                ))}
                {c.grants.length > 4 && <span>+{c.grants.length - 4}</span>}
              </div>
              <div className="card-footer">
                <Button onClick={() => edit(c)}>Название и права</Button>
                <Button onClick={() => modal(<Upload collection={c.id} after={load.reload} />)}>
                  Загрузить
                </Button>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <section className="panel">
          <EmptyState
            title={query ? 'Совпадений нет' : 'Создайте первую базу знаний'}
            description={
              query
                ? 'Попробуйте другое название.'
                : 'Назначьте доступ и загрузите документы для поиска и ответов.'
            }
          >
            <Button className="primary" onClick={() => edit()}>
              + База знаний
            </Button>
          </EmptyState>
        </section>
      )}
      <div className="info-callout">
        <strong>Личные вложения хранятся отдельно</strong>
        <p>
          Документы, прикреплённые к диалогу, доступны только его владельцу и не публикуются в этих
          базах.
        </p>
      </div>
    </>
  );
}
