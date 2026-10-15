import { observer } from 'mobx-react-lite';
import { api } from '../../shared/api/client';
import { useApplication } from '../../shared/lib/application-context';
import { text } from '../../shared/lib/form-data';
import { Field, Form } from '../../shared/ui/Form';

export const Auth = observer(function Auth() {
  const app = useApplication();

  const s = app.session.defaults;
  return (
    <main className="auth" id="main">
      <div className="auth-mark">▤ Local RAG</div>
      <h1>{app.session.phase === 'setup' ? 'Настройте библиотеку' : 'Войти в Local RAG'}</h1>
      <p className="muted">Рабочая библиотека и ответы по вашим документам.</p>
      <Form
        label={app.session.phase === 'setup' ? 'Создать администратора' : 'Войти'}
        submit={async (f) => {
          if (app.session.phase === 'setup') {
            await api('setup.create', {
              login: text(f, 'login'),
              password: text(f, 'password'),
              settings: {
                dataDir: text(f, 'dataDir'),
                backupDir: text(f, 'backupDir'),
                model: text(f, 'model'),
                maxPages: Number(f.get('maxPages')),
                maxQueue: Number(f.get('maxQueue')),
                maxBytes: Number(f.get('maxMiB')) * 1024 ** 2,
              },
            });
            sessionStorage.setItem('rag-welcome', '1');
          }
          await app.session.login(text(f, 'login'), text(f, 'password'));
        }}
      >
        <Field label="Логин" name="login" required />
        <label>
          Пароль
          <input
            type="password"
            name="password"
            required
            minLength={app.session.phase === 'setup' ? 12 : undefined}
            autoComplete={app.session.phase === 'setup' ? 'new-password' : 'current-password'}
          />
        </label>
        {app.session.phase === 'setup' && s && (
          <>
            <p className="auth-step">
              Первый запуск · 1 / 3. Подготовка моделей выполняется отдельно; после неё работа
              автономна.
            </p>
            <Field label="Каталог данных" name="dataDir" value={s.dataDir} />
            <Field label="Каталог резервных копий" name="backupDir" value={s.backupDir} />
            <Field label="Модель Ollama" name="model" value={s.model} />
            <Field label="Максимум страниц PDF" name="maxPages" value={s.maxPages} type="number" />
            <Field label="Лимит очереди" name="maxQueue" value={s.maxQueue} type="number" />
            <Field
              label="Лимит файла, МиБ"
              name="maxMiB"
              value={s.maxBytes / 1024 ** 2}
              type="number"
            />
          </>
        )}
      </Form>
      <div className="auth-footer">
        Локальные документы · собственные модели · автономная работа
      </div>
    </main>
  );
});
