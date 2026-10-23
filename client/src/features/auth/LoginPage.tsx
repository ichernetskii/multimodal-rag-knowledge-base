import { observer } from 'mobx-react-lite';
import { useApplication } from '../../shared/lib/application-context';
import { text } from '../../shared/lib/form-data';
import { Field, Form } from '../../shared/ui/Form';
export const Auth = observer(function Auth() {
  const app = useApplication();
  const invite = new URLSearchParams(location.search).get('invite');
  return (
    <main className="auth" id="main">
      <div className="auth-mark">▤ Multimodal RAG Knowledge Base</div>
      <h1>
        {app.session.phase === 'setup'
          ? 'This installation has not been configured'
          : 'Sign in to your workspace'}
      </h1>
      {app.session.phase === 'setup' ? (
        <p>
          An operator must create the first company and account using the administrative CLI. A demo
          seed command is available for development environments.
        </p>
      ) : (
        <Form
          label={'Sign in'}
          submit={async (f) => app.session.login(text(f, 'login'), text(f, 'password'))}
        >
          <Field label={'Username'} name="login" required />
          <label>
            Password
            <input type="password" name="password" autoComplete="current-password" required />
          </label>
        </Form>
      )}
      {invite && (
        <Form
          label={'Accept invitation'}
          submit={async (f) => {
            const r = await fetch('/api/invitations/accept', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: invite, password: text(f, 'invitePassword') }),
            });
            const data = (await r.json()) as { login?: string; error?: { message: string } };
            if (!r.ok || !data.login)
              throw new Error(data.error?.message ?? 'Could not accept the invitation');
            history.replaceState(null, '', '/');
            await app.session.login(data.login, text(f, 'invitePassword'));
          }}
        >
          <p>
            For a new account, choose a password of at least 12 characters. For an existing account,
            enter your current password.
          </p>
          <Field label={'Account password'} name="invitePassword" type="password" required />
        </Form>
      )}
      <p className="muted">Documents, search, and answers in your company workspace.</p>
    </main>
  );
});
