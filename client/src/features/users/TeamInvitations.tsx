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
      <h2>Пригласить сотрудника</h2>
      <p>Создайте одноразовую ссылку и передайте её сотруднику. Он самостоятельно задаст пароль.</p>
      <Form
        label="Создать приглашение"
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
          <Field label="Логин приглашённого" name="login" required />
          <Select
            label="Роль приглашённого"
            name="role"
            value="user"
            options={Object.entries(roleNames)}
          />
        </div>
      </Form>
      {link && (
        <div className="info-callout" role="status">
          <strong>Ссылка готова. Сохраните её: повторно она не показывается.</strong>
          <label>
            Ссылка приглашения
            <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <p>
            Каждый, кто получит эту ссылку, сможет принять приглашение. Передавайте её только
            нужному сотруднику.
          </p>
        </div>
      )}
      {load.error && <Loading error={load.error} retry={load.reload} />}
      {Boolean(load.data?.length) && (
        <details className="admin-details">
          <summary>Приглашения ({load.data?.length})</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Логин</th>
                  <th>Роль</th>
                  <th>Состояние</th>
                  <th>Действие</th>
                </tr>
              </thead>
              <tbody>
                {load.data?.map((i) => (
                  <tr key={i.id}>
                    <td>{i.login}</td>
                    <td>{roleNames[i.role]}</td>
                    <td>
                      {i.used
                        ? 'Принято'
                        : i.expires < Date.now()
                          ? 'Истекло'
                          : 'До ' + new Date(i.expires).toLocaleString()}
                    </td>
                    <td>
                      {!i.used && (
                        <Button
                          onClick={async () => {
                            await api('invitations.revoke', { id: i.id });
                            load.reload();
                          }}
                        >
                          Отозвать
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
