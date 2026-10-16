import { observer } from 'mobx-react-lite';
import { useApplication } from '../../shared/lib/application-context';
import { text } from '../../shared/lib/form-data';
import { Field, Form } from '../../shared/ui/Form';
export const Auth = observer(function Auth() {
  const app = useApplication();
  const invite = new URLSearchParams(location.search).get('invite');
  return (
    <main className="auth" id="main">
      <div className="auth-mark">▤ Knowledge Workspace</div>
      <h1>
        {app.session.phase === 'setup'
          ? 'Установка ещё не настроена'
          : 'Войти в рабочее пространство'}
      </h1>
      {app.session.phase === 'setup' ? (
        <p>
          Оператор должен создать первую компанию и учётную запись через административную CLI. Для
          окружения разработки предусмотрена команда заполнения демонстрационными данными.
        </p>
      ) : (
        <Form
          label="Войти"
          submit={async (f) => app.session.login(text(f, 'login'), text(f, 'password'))}
        >
          <Field label="Логин" name="login" required />
          <label>
            Пароль
            <input type="password" name="password" autoComplete="current-password" required />
          </label>
        </Form>
      )}
      {invite && (
        <Form
          label="Принять приглашение"
          submit={async (f) => {
            const r = await fetch('/api/invitations/accept', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: invite, password: text(f, 'invitePassword') }),
            });
            const data = (await r.json()) as { login?: string; error?: { message: string } };
            if (!r.ok || !data.login)
              throw new Error(data.error?.message ?? 'Не удалось принять приглашение');
            history.replaceState(null, '', '/');
            await app.session.login(data.login, text(f, 'invitePassword'));
          }}
        >
          <p>
            Для нового аккаунта придумайте пароль от 12 символов, для существующего — введите
            текущий.
          </p>
          <Field label="Пароль аккаунта" name="invitePassword" type="password" required />
        </Form>
      )}
      <p className="muted">Документы, поиск и ответы в пространстве вашей компании.</p>
    </main>
  );
});
