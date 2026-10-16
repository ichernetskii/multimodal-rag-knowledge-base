import { useState } from 'react';
import { api } from '../../shared/api/client';
import { useApplication } from '../../shared/lib/application-context';
import { useLoad, usePolling } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Form } from '../../shared/ui/Form';
import { Badge, EmptyState, Loading, Metric, PageHeader } from '../../shared/ui/Feedback';
import { ModelAvailability } from '../saas/ModelAvailability';
import { Limits } from '../settings/SettingsPage';
import { AdminLink, money } from './AdminUI';
const indexStates = {
  building: 'Строится',
  ready: 'Готов к переключению',
  active: 'Используется в поиске',
  failed: 'Построение не удалось',
} as const;
export function Indexes() {
  const app = useApplication(),
    models = useLoad((signal) => api('models.list', {}, { signal })),
    indexes = useLoad((signal) => api('indexes.list', {}, { signal })),
    settings = useLoad((signal) => api('settings.read', {}, { signal }));
  const [selected, setSelected] = useState(''),
    [message, setMessage] = useState('');
  usePolling(indexes.reload, 3000, Boolean(indexes.data?.some((i) => i.state === 'building')));
  const choices = models.data?.filter((p) => p.role === 'embedding' && p.enabled) ?? [],
    profile = choices.find((p) => p.id === (selected || choices[0]?.id)),
    active = models.data?.find((p) => p.id === settings.data?.embeddingProfile),
    activeIndex = indexes.data?.find((index) => index.state === 'active');
  return (
    <>
      <PageHeader
        title="Поисковый индекс"
        description="Поиск использует одну embedding-модель. При её замене сначала строится новый индекс, затем вы включаете его."
      />
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Сейчас в поиске</h2>
            <p>
              {models.loading || settings.loading
                ? 'Загрузка модели…'
                : (active?.name ?? 'Модель поиска недоступна')}{' '}
              {active && <code>{active.model}</code>}
            </p>
          </div>
          <Badge tone={activeIndex ? 'success' : 'neutral'}>
            {indexes.loading
              ? 'Проверяем индекс…'
              : indexes.error
                ? 'Состояние индекса неизвестно'
                : activeIndex
                  ? 'Индекс активен'
                  : 'Поиск ещё не подготовлен'}
          </Badge>
        </div>
        <p>
          Обычное добавление документов обновляет активный индекс автоматически. Перестроение нужно
          при смене модели поиска.
        </p>
        {active && <ModelAvailability profile={active} />}
        {!indexes.loading && !indexes.error && !activeIndex && (
          <p className="info-callout">
            Опубликуйте первый материал или постройте индекс ниже. До завершения индексации
            материалы не участвуют в поиске.
          </p>
        )}
      </section>
      {message && (
        <p className="info-callout" role="status">
          {message}
        </p>
      )}
      <section className="panel">
        <h2>Подготовить другой индекс</h2>
        <ol className="admin-steps">
          <li>Выберите доступную модель поиска.</li>
          <li>Дождитесь завершения построения — текущий поиск продолжит работать.</li>
          <li>Проверьте результат и нажмите «Использовать в поиске».</li>
        </ol>
        <p>
          Если новой модели нужен текст, недостающие описания и расшифровки подготовятся
          автоматически. Уже готовый текст сохранится. Описания создаёт модель ответов с поддержкой
          изображений, расшифровки — выбранный Whisper или Google Gemini. Внешние вызовы учитываются
          в бюджете компании. Проверьте подготовленный текст в материалах перед включением нового
          поиска.
        </p>
        {models.error && <Loading error={models.error} retry={models.reload} />}
        {models.data && !choices.length && (
          <p className="info-callout">
            Нет разрешённых моделей поиска. Обратитесь к владельцу платформы для настройки
            AI-подключения.
          </p>
        )}
        <Form
          label="Построить новый индекс"
          disabled={!profile}
          submit={async () => {
            if (!profile) return;
            const job = await api('indexes.build', { profile: profile.id });
            app.jobs.upsert(job);
            app.jobs.watch(job);
            indexes.reload();
            setMessage('Индекс строится. Список ниже обновляется автоматически.');
          }}
        >
          <label>
            Модель поиска
            <select
              value={profile?.id ?? ''}
              onChange={(e) => setSelected(e.target.value)}
              required
            >
              {choices.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.model}
                </option>
              ))}
            </select>
          </label>
          {profile && <ModelAvailability profile={profile} />}
        </Form>
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>Индексы компании</h2>
          <Button onClick={indexes.reload}>Обновить</Button>
        </div>
        {indexes.error && <Loading error={indexes.error} retry={indexes.reload} />}
        {indexes.data?.length === 0 && (
          <EmptyState
            title="Отдельных индексов пока нет"
            description="Добавьте документы или подготовьте новый индекс с выбранной моделью."
          />
        )}
        <div className="admin-index-list">
          {indexes.data?.map((i) => (
            <article className="admin-index" key={i.id}>
              <div>
                <strong>
                  {models.data?.find((p) => p.id === i.profile)?.name ?? 'Модель поиска'}
                </strong>
                <p>
                  {new Date(i.created).toLocaleString()} · {i.documents} документов при построении
                </p>
                <Badge
                  tone={
                    i.state === 'active'
                      ? 'success'
                      : i.state === 'failed'
                        ? 'danger'
                        : i.state === 'building'
                          ? 'info'
                          : 'neutral'
                  }
                >
                  {indexStates[i.state]}
                </Badge>
                <details>
                  <summary>Технический идентификатор</summary>
                  <code>{i.id}</code>
                </details>
              </div>
              {i.state === 'ready' && (
                <div>
                  <Button
                    disabled={!models.data?.find((p) => p.id === i.profile)?.enabled}
                    onClick={async () => {
                      await api('indexes.activate', { id: i.id });
                      indexes.reload();
                      settings.reload();
                      setMessage('Поиск переключён на выбранный индекс.');
                    }}
                  >
                    Использовать в поиске
                  </Button>
                  {models.data && !models.data.find((p) => p.id === i.profile)?.enabled && (
                    <p className="muted">
                      Профиль модели выключен. Владелец платформы должен разрешить его перед
                      переключением.
                    </p>
                  )}
                </div>
              )}
              {i.state === 'failed' && (
                <AdminLink to="operations">Посмотреть ошибку задания</AdminLink>
              )}
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
export function Usage() {
  const app = useApplication(),
    usage = useLoad((signal) => api('usage.read', {}, { signal })),
    models = useLoad((signal) => api('models.list', {}, { signal }));
  const value = usage.data;
  return (
    <>
      <PageHeader
        title="Расходы и лимиты"
        description="Бюджет, использование моделей и доступные ресурсы выбранной компании."
        actions={<Button onClick={() => usage.reload()}>Обновить</Button>}
      />
      {!value ? (
        <Loading error={usage.error} retry={usage.reload} />
      ) : (
        <>
          <div className="metrics-grid">
            <Metric
              label="Расходы за месяц"
              value={money(value.spentMicros)}
              detail={value.month}
            />
            <Metric
              label="Бюджет AI"
              value={money(value.budgetMicros)}
              detail="Предельные расходы компании"
            />
            <Metric
              label="В резерве"
              value={money(value.reservedMicros)}
              detail="Незавершённые вызовы моделей"
            />
            <Metric
              label="Файлы"
              value={(value.storageBytes / 1024 ** 2).toFixed(1) + ' МиБ'}
              detail="Оригиналы и производные материалы"
            />
          </div>
          {value.uncertainMicros > 0 && (
            <p role="alert" className="info-callout">
              Есть попытки с неподтверждённым результатом на {money(value.uncertainMicros)}. Перед
              повтором проверьте использование у поставщика AI.
            </p>
          )}
          <section className="panel">
            <h2>Использование моделей</h2>
            <p>
              Стоимость — оценка по настроенным тарифам. Локальные вызовы не оплачиваются поставщику
              API, но используют ресурсы вашего сервера.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Модель</th>
                    <th>Вызовы</th>
                    <th>Токены: вход / выход</th>
                    <th>Вход по модальностям</th>
                    <th>Расходы</th>
                  </tr>
                </thead>
                <tbody>
                  {value.calls.map((c) => (
                    <tr key={c.profile}>
                      <td>
                        {models.data?.find((p) => p.id === c.profile)?.name ?? 'Профиль модели'}
                      </td>
                      <td>{c.calls}</td>
                      <td>
                        {c.input} / {c.output}
                      </td>
                      <td>
                        {(
                          [
                            ['text', 'Текст'],
                            ['image', 'Изображения'],
                            ['audio', 'Аудио'],
                            ['video', 'Видео'],
                            ['unattributed', 'Без разбивки'],
                          ] as const
                        ).map(
                          ([kind, label]) =>
                            c.modalities[kind].tokens > 0 && (
                              <div key={kind}>
                                {label}: {c.modalities[kind].tokens} ток. ·{' '}
                                {money(c.modalities[kind].costMicros)}
                              </div>
                            ),
                        )}
                        {c.estimatedCalls > 0 && (
                          <p className="muted">
                            Оценочных вызовов: {c.estimatedCalls}. Уточняйте итоговый счёт у
                            поставщика.
                          </p>
                        )}
                      </td>
                      <td>{money(c.costMicros)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!value.calls.length && <p className="muted">За этот месяц вызовов пока нет.</p>}
          </section>
        </>
      )}
      <Limits onSaved={usage.reload} />
      <details className="panel admin-details">
        <summary>Обслуживание кеша</summary>
        <p>
          Используйте после диагностики. Обновления материалов и прав сбрасывают соответствующий кеш
          автоматически.
        </p>
        <Button
          onClick={async () => {
            await api('cache.clear');
            app.notify('Кеш поиска и ответов компании сброшен.');
          }}
        >
          Сбросить кеш компании
        </Button>
      </details>
    </>
  );
}
const actionNames: Record<string, string> = {
  'documents.upload': 'Загрузка документа',
  'documents.delete': 'Удаление документа',
  'collections.save': 'Изменение базы знаний',
  'models.save': 'Изменение AI-подключения',
  'settings.save': 'Изменение настроек',
  'tenants.create': 'Создание компании',
  'indexes.activate': 'Переключение поискового индекса',
};
export function Audit() {
  const [page, setPage] = useState(1),
    load = useLoad((signal) => api('audit.list', { page, pageSize: 25 }, { signal }), [page]);
  return (
    <>
      <PageHeader
        title="Журнал действий"
        description="Действия и изменения в выбранной компании. Данные других компаний сюда не попадают."
        actions={<Button onClick={load.reload}>Обновить</Button>}
      />
      <section className="panel">
        {!load.data ? (
          <Loading error={load.error} retry={load.reload} />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Когда</th>
                    <th>Что произошло</th>
                    <th>Подробности</th>
                  </tr>
                </thead>
                <tbody>
                  {load.data.items.map((item) => (
                    <tr key={item.id}>
                      <td>{new Date(item.created).toLocaleString()}</td>
                      <td>{actionNames[item.action] ?? item.action}</td>
                      <td>
                        <details>
                          <summary>Идентификаторы</summary>
                          <p>
                            Действие: <code>{item.action}</code>
                          </p>
                          <p>
                            Участник: <code>{item.actor}</code>
                          </p>
                          <p>
                            Объект: <code>{item.target || '—'}</code>
                          </p>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!load.data.items.length && (
              <EmptyState
                title="Журнал пока пуст"
                description="Здесь появятся изменения документов, доступа и настроек."
              />
            )}
            <div className="admin-pagination">
              <Button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                Назад
              </Button>
              <span>Страница {page}</span>
              <Button disabled={page * 25 >= load.data.total} onClick={() => setPage((p) => p + 1)}>
                Далее
              </Button>
            </div>
          </>
        )}
      </section>
    </>
  );
}
