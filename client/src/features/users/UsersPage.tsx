import { useState } from 'react';
import { api } from '../../shared/api/client';
import type { Group, User } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { text, values, option } from '../../shared/lib/form-data';
import { useLoad, useModal, useDebouncedValue } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Check, Field, Form, Select } from '../../shared/ui/Form';
import { Badge, EmptyState, Loading, PageHeader } from '../../shared/ui/Feedback';
import { Table, Pagination } from '../../shared/ui/DataTable';
import { roleNames } from '../admin/admin-sections';
import { TeamInvitations } from './TeamInvitations';
function UserEditor({ user, groups, done }: { user?: User; groups: Group[]; done: () => void }) {
  return (
    <>
      <p className="eyebrow">УЧЁТНАЯ ЗАПИСЬ</p>
      <h2>{user ? 'Изменить пользователя' : 'Новый пользователь'}</h2>
      <p className="muted">
        Пользователь общается с документами, редактор управляет разрешёнными базами, администратор —
        командой и настройками выбранной компании. Права владельца платформы этой ролью не выдаются.
      </p>
      <Form
        label={user ? 'Сохранить изменения' : 'Создать пользователя'}
        submit={async (f) => {
          const common = {
              role: option(f, 'role', ['user', 'editor', 'admin'] as const),
              groups: values(f, 'groups'),
              blocked: f.has('blocked'),
            },
            password = text(f, 'password');
          if (user)
            await api('users.update', {
              id: user.id,
              revision: user.revision,
              ...common,
              ...(password ? { password } : {}),
            });
          else await api('users.create', { login: text(f, 'login'), password, ...common });
          done();
        }}
      >
        <div className="form-grid">
          <Field
            label="Логин"
            name="login"
            value={user?.login}
            required
            readOnly={!!user}
            autoComplete="off"
            hint={user ? 'Логин сохраняется при редактировании.' : undefined}
          />
          <Select
            label="Роль"
            name="role"
            value={user?.role ?? 'user'}
            options={Object.entries(roleNames)}
          />
        </div>
        <Field
          label={user ? 'Новый пароль' : 'Пароль'}
          name="password"
          type="password"
          required={!user}
          hint={
            user
              ? 'Оставьте пустым, чтобы сохранить текущий. Минимум 12 символов.'
              : 'Минимум 12 символов.'
          }
        />
        <section className="form-section">
          <h3>Участие в группах</h3>
          {groups.length ? (
            <div className="check-grid">
              {groups.map((g) => (
                <Check
                  key={g.id}
                  name="groups"
                  value={g.id}
                  label={g.name}
                  checked={user?.groups.includes(g.id)}
                />
              ))}
            </div>
          ) : (
            <p className="muted">Групп пока нет. Их можно создать в этом разделе.</p>
          )}
        </section>
        <Check
          label="Заблокировать вход"
          name="blocked"
          checked={user?.blocked}
          hint="Активные сессии пользователя будут отозваны после сохранения."
        />
      </Form>
    </>
  );
}
export function Users() {
  const app = useApplication(),
    modal = useModal(),
    [query, setQuery] = useState(''),
    [role, setRole] = useState<'' | 'user' | 'editor' | 'admin'>(''),
    [state, setState] = useState<'' | 'active' | 'blocked'>(''),
    [page, setPage] = useState(1),
    q = useDebouncedValue(query);
  const load = useLoad(
    async (signal) => {
      const [users, groups] = await Promise.all([
        api('users.list', { query: q, role, state, page }, { signal }),
        api('groups.list', {}, { signal }),
      ]);
      return { users, groups };
    },
    [q, role, state, page],
  );
  const edit = (user?: User) =>
    modal(
      <UserEditor
        user={user}
        groups={load.data?.groups ?? []}
        done={() => {
          modal(null);
          load.reload();
          app.notify(
            user ? 'Пользователь обновлён. Активные сессии отозваны.' : 'Пользователь создан.',
          );
        }}
      />,
    );
  const editGroup = (group?: Group) =>
    modal(
      <>
        <h2>{group ? 'Изменить группу' : 'Новая группа'}</h2>
        <Form
          submit={async (f) => {
            await api('groups.save', {
              name: text(f, 'name'),
              ...(group ? { id: group.id, revision: group.revision } : {}),
            });
            modal(null);
            load.reload();
          }}
        >
          <Field label="Название группы" name="name" value={group?.name} required />
        </Form>
      </>,
    );
  return (
    <>
      <PageHeader
        eyebrow="ДОСТУП И БЕЗОПАСНОСТЬ"
        title="Команда и роли"
        description="Сотрудники выбранной компании, приглашения и группы доступа к базам знаний."
        actions={
          <Button className="primary" onClick={() => edit()}>
            + Пользователь
          </Button>
        }
      />
      <details className="panel admin-details">
        <summary>Чем отличаются роли</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Роль</th>
                <th>Возможности</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Пользователь</td>
                <td>Чат и чтение материалов разрешённых баз знаний.</td>
              </tr>
              <tr>
                <td>Редактор</td>
                <td>Возможности пользователя и управление материалами разрешённых баз.</td>
              </tr>
              <tr>
                <td>Администратор компании</td>
                <td>Команда, доступ, настройки, расходы и обслуживание своей компании.</td>
              </tr>
              <tr>
                <td>Владелец платформы</td>
                <td>
                  Отдельное системное право: компании, подключения к AI, сервер и увеличение
                  лимитов. Не назначается через форму сотрудника.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Права владельца не дают автоматического доступа к личным чатам сотрудников. Доступ к
          материалам проверяется на сервере.
        </p>
      </details>
      <section className="panel">
        <div className="filter-bar">
          <label className="search-field">
            <span>Поиск по логину</span>
            <input
              type="search"
              value={query}
              placeholder="Найти пользователя…"
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <Select
            label="Роль"
            name="role-filter"
            options={[['', 'Все роли'], ...Object.entries(roleNames)]}
            onChange={(value) => {
              setRole(value as typeof role);
              setPage(1);
            }}
          />
          <Select
            label="Состояние"
            name="state-filter"
            options={[
              ['', 'Все'],
              ['active', 'Активные'],
              ['blocked', 'Заблокированные'],
            ]}
            onChange={(value) => {
              setState(value as typeof state);
              setPage(1);
            }}
          />
          <Button onClick={load.reload} aria-label="Обновить список пользователей">
            Обновить
          </Button>
        </div>
        {load.error && <Loading error={load.error} retry={load.reload} />}
        <div aria-busy={load.loading}>
          {!load.data ? (
            <Loading />
          ) : (
            <>
              <Table
                head={['Пользователь', 'Роль', 'Группы', 'Состояние', 'Действия']}
                rowKeys={load.data.users.items.map((u) => u.id)}
                empty="По этим условиям пользователи не найдены."
                rows={load.data.users.items.map((u) => [
                  <div className="person">
                    <span className="avatar avatar-light">{u.login.slice(0, 2).toUpperCase()}</span>
                    <strong>{u.login}</strong>
                  </div>,
                  roleNames[u.role],
                  <span className="muted">
                    {u.groups
                      .map((id) => load.data!.groups.find((g) => g.id === id)?.name ?? id)
                      .join(', ') || '—'}
                  </span>,
                  <Badge tone={u.blocked ? 'danger' : 'success'}>
                    {u.blocked ? 'Заблокирован' : 'Активен'}
                  </Badge>,
                  <div className="actions compact">
                    <Button onClick={() => edit(u)}>Изменить</Button>
                    {app.session.user?.operator && (
                      <Button
                        title="Завершить сессии пользователя во всех компаниях"
                        onClick={async () => {
                          await api('users.revoke', { id: u.id });
                          app.notify('Сессии пользователя ' + u.login + ' отозваны.');
                        }}
                      >
                        Отозвать сессии
                      </Button>
                    )}
                  </div>,
                ])}
              />
              <Pagination
                page={page}
                pageSize={load.data.users.pageSize}
                total={load.data.users.total}
                onChange={setPage}
                loading={load.loading}
              />
            </>
          )}
        </div>
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Группы доступа</h2>
            <p>Назначайте доступ сразу нескольким пользователям через группу.</p>
          </div>
          <Button onClick={() => editGroup()}>+ Группа</Button>
        </div>
        {load.data?.groups.length ? (
          <div className="group-list">
            {load.data.groups.map((g) => (
              <button key={g.id} onClick={() => editGroup(g)}>
                <span className="group-icon">◉</span>
                <strong>{g.name}</strong>
                <span>Изменить →</span>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState
            title="Объедините пользователей в группы"
            description="Создайте группу и назначьте ей доступ в разделе «Базы знаний и доступ»."
          />
        )}
      </section>
      <TeamInvitations />
    </>
  );
}
