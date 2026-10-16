import { useState } from 'react';
import { api } from '../../shared/api/client';
import type { AICredential, CredentialAudit } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { useLoad } from '../../shared/lib/hooks';
import { text, option } from '../../shared/lib/form-data';
import { Button } from '../../shared/ui/Button';
import { Field, Form, Check } from '../../shared/ui/Form';
import { Badge, Loading } from '../../shared/ui/Feedback';
export const credentialProviders = {
  google: 'Google Gemini',
  anthropic: 'Anthropic Claude',
  'openai-compatible': 'Сервер с OpenAI API',
} as const;
const auditNames: Record<CredentialAudit['action'], string> = {
  created: 'Добавлен',
  updated: 'Изменены параметры',
  rotated: 'Заменено значение',
  enabled: 'Включён',
  disabled: 'Отключён',
  deleted: 'Удалён',
};
export function CredentialsPanel({
  credentials,
  loading,
  error,
  reload,
  onChanged,
}: {
  credentials: AICredential[];
  loading: boolean;
  error: string;
  reload: () => void;
  onChanged: () => void;
}) {
  const app = useApplication(),
    [editing, setEditing] = useState<AICredential | 'new' | null>(null),
    [deleting, setDeleting] = useState<AICredential | null>(null),
    [page, setPage] = useState(1);
  const audit = useLoad(
    (signal) => api('secrets.audit', { page, pageSize: 25 }, { signal }),
    [page],
  );
  const changed = () => {
    onChanged();
    audit.reload();
  };
  const old = editing && editing !== 'new' ? editing : null;
  const editKey = (value: typeof editing) => {
    if (!app.unsaved.confirmDiscard('page')) return false;
    setEditing(value);
    return true;
  };
  return (
    <section className="panel admin-credentials">
      <div className="section-heading">
        <div>
          <h2>API-ключи платформы</h2>
          <p>Общие для всех компаний. Доступ к управлению есть только у владельца платформы.</p>
        </div>
        <div className="actions">
          <Button
            onClick={() => {
              reload();
              audit.reload();
            }}
          >
            Обновить реестр
          </Button>
          <Button
            className="primary"
            onClick={() => {
              if (editKey('new')) setDeleting(null);
            }}
          >
            + Добавить API-ключ
          </Button>
        </div>
      </div>
      <p>
        Значения зашифрованы на сервере и после сохранения не показываются. Добавление, замена и
        отключение применяются к новым вызовам API и воркеров без перезапуска.
      </p>
      {error && <Loading error={error} retry={reload} />}
      {editing && (
        <div className="admin-credential-form">
          <div className="section-heading">
            <h3>{old ? 'Изменить ключ «' + old.label + '»' : 'Добавить API-ключ'}</h3>
            <Button onClick={() => editKey(null)}>Закрыть</Button>
          </div>
          <Form
            protectChanges
            autoComplete="off"
            key={old ? old.id + ':' + old.revision : 'new'}
            label={old ? 'Сохранить изменения ключа' : 'Сохранить API-ключ'}
            submit={async (f) => {
              const value = text(f, 'apiCredentialValue');
              await api('secrets.save', {
                id: text(f, 'credentialId'),
                label: text(f, 'credentialLabel'),
                provider: option(f, 'provider', [
                  'google',
                  'anthropic',
                  'openai-compatible',
                ] as const),
                revision: old?.revision ?? 0,
                enabled: f.has('enabled'),
                ...(value ? { value } : {}),
              });
              setEditing(null);
              changed();
              app.notify(
                old
                  ? 'Изменения ключа применены. Перезапуск не нужен.'
                  : 'API-ключ сохранён. Теперь выберите его в подключении модели.',
              );
            }}
          >
            <div className="form-grid">
              <Field
                label="Название ключа"
                name="credentialLabel"
                value={old?.label}
                required
                maxLength={120}
                hint="Например, Google · основной. Сам ключ сюда не вставляйте."
              />
              <Field
                label="Идентификатор ключа"
                name="credentialId"
                value={old?.id}
                required
                readOnly={!!old}
                maxLength={64}
                autoComplete="off"
                hint="Латинские строчные буквы, цифры, _ и -. Например, google или google-production."
              />
            </div>
            <label>
              Поставщик ключа
              <select name="provider" defaultValue={old?.provider ?? 'google'} disabled={!!old}>
                {Object.entries(credentialProviders).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            {old && <input type="hidden" name="provider" value={old.provider} />}
            <Field
              label={old ? 'Новое значение API-ключа' : 'Значение API-ключа'}
              name="apiCredentialValue"
              type="password"
              autoComplete="new-password"
              autoCapitalize="none"
              spellCheck={false}
              required={!old}
              maxLength={8192}
              minLength={8}
              hint={
                old
                  ? 'Оставьте пустым, чтобы сохранить текущее значение. Для замены вставьте новый ключ; старое значение не возвращается.'
                  : 'Вставьте ключ, полученный у поставщика. Он будет отправлен только нашему серверу и сохранён в зашифрованном виде.'
              }
            />
            <Check
              name="enabled"
              label="Разрешить новые вызовы с этим ключом"
              checked={old?.enabled ?? true}
            />
          </Form>
        </div>
      )}
      {!credentials.length && !loading && !error && (
        <p className="info-callout">
          Внешние API-ключи пока не добавлены. Ollama и встроенный Whisper работают без них.
        </p>
      )}
      {loading && !credentials.length && !error && <Loading />}
      {Boolean(credentials.length) && (
        <div className="credential-list">
          {credentials.map((c) => (
            <article className="credential-card" key={c.id} aria-label={'API-ключ: ' + c.label}>
              <div className="section-heading">
                <div>
                  <h3>{c.label}</h3>
                  <code>{c.id}</code>
                </div>
                <Badge tone={c.enabled ? 'success' : 'neutral'}>
                  {c.enabled ? 'Включён' : 'Отключён'}
                </Badge>
              </div>
              <p>
                {credentialProviders[c.provider]} · {c.uses} профилей во всех компаниях
              </p>
              <p className="muted">
                Значение скрыто · изменён {new Date(c.updated).toLocaleString()}
              </p>
              <div className="actions">
                <Button
                  onClick={() => {
                    if (editKey(c)) setDeleting(null);
                  }}
                >
                  Изменить / заменить
                </Button>
                <Button
                  onClick={async () => {
                    await api('secrets.save', {
                      id: c.id,
                      label: c.label,
                      provider: c.provider,
                      enabled: !c.enabled,
                      revision: c.revision,
                    });
                    changed();
                    app.notify(
                      c.enabled
                        ? 'Ключ отключён для новых вызовов всех компаний.'
                        : 'Ключ включён для новых вызовов.',
                    );
                  }}
                >
                  {c.enabled ? 'Отключить' : 'Включить'}
                </Button>
                <Button
                  className="danger"
                  disabled={c.uses > 0}
                  title={
                    c.uses
                      ? 'Сначала смените ключ во всех использующих его профилях'
                      : 'Удалить из зашифрованного хранилища'
                  }
                  onClick={() => {
                    if (editKey(null)) setDeleting(c);
                  }}
                >
                  Удалить
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
      {deleting && (
        <div className="info-callout" role="alertdialog" aria-label="Удаление API-ключа">
          <strong>Удалить ключ «{deleting.label}»?</strong>
          <p>
            Восстановить его значение из админки будет невозможно. Удаление из этой системы не
            отзывает ключ у поставщика.
          </p>
          <div className="actions">
            <Button onClick={() => setDeleting(null)}>Отмена</Button>
            <Button
              className="danger"
              onClick={async () => {
                await api('secrets.delete', { id: deleting.id, revision: deleting.revision });
                setDeleting(null);
                changed();
                app.notify('Ключ удалён.');
              }}
            >
              Подтвердить удаление
            </Button>
          </div>
        </div>
      )}
      <p className="muted">
        Чтобы удалить используемый ключ, сначала выберите другой в связанных профилях моделей.
        Отключение останавливает новые обращения к поставщику; уже отправленные запросы могут
        завершиться. Для проверки ключа выберите его в подключении и проверьте доступность модели.
      </p>
      <details className="admin-details">
        <summary>Журнал изменений API-ключей</summary>
        {audit.error && <Loading error={audit.error} retry={audit.reload} />}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Когда</th>
                <th>Ключ</th>
                <th>Действие</th>
                <th>Кто</th>
              </tr>
            </thead>
            <tbody>
              {audit.data?.items.map((a) => (
                <tr key={a.id}>
                  <td>{new Date(a.created).toLocaleString()}</td>
                  <td>
                    <code>{a.credential}</code>
                  </td>
                  <td>
                    {auditNames[a.action]} · {a.enabled ? 'включён' : 'отключён'}
                  </td>
                  <td>{a.actorLogin}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {audit.data && !audit.data.items.length && <p className="muted">Изменений пока нет.</p>}
        <div className="admin-pagination">
          <Button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            Назад
          </Button>
          <span>Страница {page}</span>
          <Button
            disabled={!audit.data || page * audit.data.pageSize >= audit.data.total}
            onClick={() => setPage((p) => p + 1)}
          >
            Далее
          </Button>
        </div>
      </details>
    </section>
  );
}
