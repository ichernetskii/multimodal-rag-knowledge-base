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
      <p className="eyebrow">ACCOUNT</p>
      <h2>{user ? 'Edit user' : 'New user'}</h2>
      <p className="muted">
        Users chat with documents, editors manage permitted knowledge bases, and administrators
        manage their company's team and settings. This role does not grant platform owner access.
      </p>
      <Form
        label={user ? 'Save changes' : 'Create user'}
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
            label={'Username'}
            name="login"
            value={user?.login}
            required
            readOnly={!!user}
            autoComplete="off"
            hint={user ? 'The username cannot be changed.' : undefined}
          />
          <Select
            label={'Role'}
            name="role"
            value={user?.role ?? 'user'}
            options={Object.entries(roleNames)}
          />
        </div>
        <Field
          label={user ? 'New password' : 'Password'}
          name="password"
          type="password"
          required={!user}
          hint={
            user
              ? 'Leave blank to keep the current password. At least 12 characters.'
              : 'At least 12 characters.'
          }
        />
        <section className="form-section">
          <h3>Group membership</h3>
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
            <p className="muted">No groups yet. Create one in this section.</p>
          )}
        </section>
        <Check
          label={'Block sign-in'}
          name="blocked"
          checked={user?.blocked}
          hint={"The user's active sessions will be revoked when you save."}
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
          app.notify(user ? 'User updated. Active sessions revoked.' : 'User created.');
        }}
      />,
    );
  const editGroup = (group?: Group) =>
    modal(
      <>
        <h2>{group ? 'Edit group' : 'New group'}</h2>
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
          <Field label={'Group name'} name="name" value={group?.name} required />
        </Form>
      </>,
    );
  return (
    <>
      <PageHeader
        eyebrow={'ACCESS AND SECURITY'}
        title={'Team and roles'}
        description={
          'Team members, invitations, and knowledge base access groups for the selected company.'
        }
        actions={
          <Button className="primary" onClick={() => edit()}>
            + User
          </Button>
        }
      />
      <details className="panel admin-details">
        <summary>How roles differ</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Permissions</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Member</td>
                <td>Chat and read materials in permitted knowledge bases.</td>
              </tr>
              <tr>
                <td>Editor</td>
                <td>User permissions plus managing materials in permitted knowledge bases.</td>
              </tr>
              <tr>
                <td>Company administrator</td>
                <td>Manage the company's team, access, settings, costs, and maintenance.</td>
              </tr>
              <tr>
                <td>Platform owner</td>
                <td>
                  Separate system permission: companies, AI connections, server, and increasing
                  limits. Cannot be assigned through the team member form.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Platform ownership does not automatically grant access to employees' private chats.
          Material access is checked by the server.
        </p>
      </details>
      <section className="panel">
        <div className="filter-bar">
          <label className="search-field">
            <span>Search by username</span>
            <input
              type="search"
              value={query}
              placeholder={'Find a user…'}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <Select
            label={'Role'}
            name="role-filter"
            options={[['', 'All roles'], ...Object.entries(roleNames)]}
            onChange={(value) => {
              setRole(value as typeof role);
              setPage(1);
            }}
          />
          <Select
            label={'Status'}
            name="state-filter"
            options={[
              ['', 'All'],
              ['active', 'Active'],
              ['blocked', 'Blocked'],
            ]}
            onChange={(value) => {
              setState(value as typeof state);
              setPage(1);
            }}
          />
          <Button onClick={load.reload} aria-label={'Refresh user list'}>
            Refresh
          </Button>
        </div>
        {load.error && <Loading error={load.error} retry={load.reload} />}
        <div aria-busy={load.loading}>
          {!load.data ? (
            <Loading />
          ) : (
            <>
              <Table
                head={['Member', 'Role', 'Groups', 'Status', 'Actions']}
                rowKeys={load.data.users.items.map((u) => u.id)}
                empty={'No users match these filters.'}
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
                    {u.blocked ? 'Blocked' : 'Active'}
                  </Badge>,
                  <div className="actions compact">
                    <Button onClick={() => edit(u)}>Edit</Button>
                    {app.session.user?.operator && (
                      <Button
                        title={"End the user's sessions in all companies"}
                        onClick={async () => {
                          await api('users.revoke', { id: u.id });
                          app.notify('Sessions for user ' + u.login + ' revoked.');
                        }}
                      >
                        Revoke sessions
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
            <h2>Access groups</h2>
            <p>Grant access to several users at once through a group.</p>
          </div>
          <Button onClick={() => editGroup()}>+ Group</Button>
        </div>
        {load.data?.groups.length ? (
          <div className="group-list">
            {load.data.groups.map((g) => (
              <button key={g.id} onClick={() => editGroup(g)}>
                <span className="group-icon">◉</span>
                <strong>{g.name}</strong>
                <span>Edit →</span>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState
            title={'Organize users into groups'}
            description={'Create a group and grant access under “Knowledge bases and access”.'}
          />
        )}
      </section>
      <TeamInvitations />
    </>
  );
}
