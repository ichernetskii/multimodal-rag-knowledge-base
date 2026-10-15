import { api } from '../../shared/api/client';
import { useApplication } from '../../shared/lib/application-context';
import { text } from '../../shared/lib/form-data';
import { useLoad } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Field, Form } from '../../shared/ui/Form';
import { Loading } from '../../shared/ui/Feedback';

export function Account() {
  const app = useApplication();

  const load = useLoad(() => api('sessions.list'));
  return (
    <>
      <h2>Активные сессии</h2>
      {load.data?.map((s) => (
        <div className="card" key={s.id}>
          {new Date(s.created).toLocaleString()}
          <Button
            onClick={async () => {
              await api('sessions.revoke', { id: s.id });
              await app.boot();
              load.reload();
            }}
          >
            Отозвать
          </Button>
        </div>
      ))}
      {load.loading && <Loading error={load.error} />}
      <h2>Сменить пароль</h2>
      <Form
        submit={async (f) => {
          await api('password.change', {
            oldPassword: text(f, 'oldPassword'),
            password: text(f, 'password'),
          });
          app.session.signedOut();
        }}
      >
        <Field
          label="Текущий пароль"
          name="oldPassword"
          type="password"
          required
          minLength={1}
          autoComplete="current-password"
        />
        <Field label="Новый пароль" name="password" type="password" required />
      </Form>
    </>
  );
}
