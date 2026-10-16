import { useState } from 'react';
import { api } from '../../shared/api/client';
import type { ModelProfile } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { useLoad } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { PageHeader, Loading } from '../../shared/ui/Feedback';
import { ModelAvailability } from './ModelAvailability';
import {
  providerNames,
  taskNames,
  modalityNames,
  createProfile,
  isOwnServer,
  needsCredential,
} from '../models/model-catalog';
import { ModelProfileEditor } from '../models/ModelProfileEditor';
import { AdminLink } from '../admin/AdminUI';
import { Badge } from '../../shared/ui/Feedback';
export function Connections() {
  const app = useApplication(),
    models = useLoad((signal) => api('models.list', {}, { signal })),
    keys = useLoad((signal) => api('secrets.list', {}, { signal }));
  const [editing, setEditing] = useState<ModelProfile | null>(null),
    [availabilityRefresh, setAvailabilityRefresh] = useState(0);
  const editProfile = (p: ModelProfile) => {
    setEditing(p);
  };
  const operator = Boolean(app.session.user?.operator);
  const company =
    app.session.tenants.find((t) => t.id === app.session.user?.tenant)?.name ?? 'компании';
  if (editing)
    return (
      <ModelProfileEditor
        profile={editing}
        credentials={keys.data ?? []}
        loading={keys.loading}
        error={keys.error}
        reload={keys.reload}
        done={() => {
          setEditing(null);
          models.reload();
          keys.reload();
        }}
        cancel={() => setEditing(null)}
      />
    );
  return (
    <>
      <PageHeader
        title="Подключённые модели"
        description={
          'Профили моделей компании «' +
          company +
          '». Общие API-ключи настраиваются отдельно в разделе платформы.'
        }
        actions={
          <>
            <Button className="primary" onClick={() => editProfile(createProfile())}>
              + Подключить модель
            </Button>
            <Button onClick={() => editProfile(createProfile('google', 'transcription'))}>
              + Google-расшифровка
            </Button>
          </>
        }
      />
      <div className="info-callout">
        Профили принадлежат этой компании.{' '}
        <AdminLink to="credentials">API-ключи платформы →</AdminLink>
      </div>
      <section className="panel">
        <h2>Профили моделей</h2>
        <p>
          Для внешних моделей выберите ключ из реестра платформы. Администраторы компаний не видят
          значения ключей и не могут менять подключения. Профиль TEST AI предназначен для разработки
          и проверок.
        </p>
        <p>
          Разрешение профиля не устанавливает модель и не запускает Ollama. Доступность проверяется
          с сервера автоматически при открытии раздела; проверка не генерирует платный ответ.
        </p>
        <Button onClick={() => setAvailabilityRefresh((n) => n + 1)}>Проверить все модели</Button>
        {models.error && <Loading error={models.error} retry={models.reload} />}
        {[
          {
            own: true,
            title: 'На вашем сервере',
            description:
              'Whisper работает на сервере приложения. Ollama — по указанному адресу вашего сервера моделей.',
          },
          {
            own: false,
            title: 'Через внешний API',
            description:
              'Google, Anthropic и серверы с совместимым API. Совместимый сервер может быть вашим собственным; его расположение определяется адресом.',
          },
        ].map((group) => (
          <section className="model-provider-group" key={group.title}>
            <h3>{group.title}</h3>
            <p className="muted">{group.description}</p>
            <div className="model-profiles">
              {models.data
                ?.filter((p) => isOwnServer(p.provider) === group.own)
                .map((p) => (
                  <article className="model-profile" key={p.id} aria-label={p.name}>
                    <h3>{p.name}</h3>
                    <Badge tone={isOwnServer(p.provider) ? 'success' : 'info'}>
                      {isOwnServer(p.provider) ? 'Свой сервер' : 'Через API'}
                    </Badge>
                    <p>
                      <code>{p.model}</code> · {p.enabled ? 'Разрешён' : 'Выключен'}
                    </p>
                    <p>
                      {providerNames[p.provider]} · {taskNames[p.role]}
                      <br />
                      Вход: {p.input.map((m) => modalityNames[m]).join(', ')}
                    </p>
                    {needsCredential(p.provider) && (
                      <p>
                        Ключ:{' '}
                        <AdminLink to="credentials">
                          {keys.data?.find((key) => key.id === p.secretRef)?.label ??
                            (p.secretRef || 'Не выбран')}
                        </AdminLink>
                        {' · '}
                        {keys.loading
                          ? 'Проверяем…'
                          : keys.error
                            ? 'Состояние неизвестно'
                            : keys.data?.some((key) => key.id === p.secretRef && key.enabled)
                              ? 'Включён'
                              : 'Нужна настройка'}
                      </p>
                    )}
                    <ModelAvailability profile={p} refresh={availabilityRefresh} />
                    <div className="model-profile-actions">
                      {operator && <Button onClick={() => editProfile(p)}>Изменить</Button>}
                      {operator && (
                        <Button
                          onClick={() =>
                            editProfile({
                              ...p,
                              id: crypto.randomUUID(),
                              revision: 0,
                              name: p.name + ' — копия',
                              enabled: false,
                            })
                          }
                        >
                          Копировать
                        </Button>
                      )}
                      {operator && (
                        <Button
                          onClick={async () => {
                            await api('models.delete', { id: p.id, revision: p.revision });
                            models.reload();
                          }}
                        >
                          Удалить
                        </Button>
                      )}
                    </div>
                  </article>
                ))}
            </div>
          </section>
        ))}
      </section>
    </>
  );
}
