import { useState } from 'react';
import { api } from '../../shared/api/client';
import { useLoad } from '../../shared/lib/hooks';
import { text, option } from '../../shared/lib/form-data';
import { Button } from '../../shared/ui/Button';
import { Field, Form, Select } from '../../shared/ui/Form';
import { Loading } from '../../shared/ui/Feedback';
import { roleNames } from '../admin/admin-sections';
export function TeamInvitations() {
  const load = useLoad((signal) => api('invitations.list', {}, { signal })),
    [link, setLink] = useState('');
  return (
    <section className="panel">
      <h2>Invite a team member</h2>
      <p>
        Create a single-use link and share it with your team member. They will set their own
        password.
      </p>
      <Form
        label={'Create invitation'}
        submit={async (f) => {
          const invitation = await api('invitations.create', {
            login: text(f, 'login'),
            role: option(f, 'role', ['user', 'editor', 'admin'] as const),
          });
          setLink(location.origin + '/?invite=' + encodeURIComponent(invitation.token));
          load.reload();
        }}
      >
        <div className="form-grid">
          <Field label={'Invited username'} name="login" required />
          <Select
            label={'Invited role'}
            name="role"
            value="user"
            options={Object.entries(roleNames)}
          />
        </div>
      </Form>
      {link && (
        <div className="info-callout" role="status">
          <strong>Your link is ready. Save it now: it will not be shown again.</strong>
          <label>
            Invitation link
            <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <p>
            Anyone with this link can accept the invitation. Share it only with the intended team
            member.
          </p>
        </div>
      )}
      {load.error && <Loading error={load.error} retry={load.reload} />}
      {Boolean(load.data?.length) && (
        <details className="admin-details">
          <summary>Invitations ({load.data?.length})</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {load.data?.map((i) => (
                  <tr key={i.id}>
                    <td>{i.login}</td>
                    <td>{roleNames[i.role]}</td>
                    <td>
                      {i.used
                        ? 'Accepted'
                        : i.expires < Date.now()
                          ? 'Expired'
                          : 'Until ' + new Date(i.expires).toLocaleString()}
                    </td>
                    <td>
                      {!i.used && (
                        <Button
                          onClick={async () => {
                            await api('invitations.revoke', { id: i.id });
                            load.reload();
                          }}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
