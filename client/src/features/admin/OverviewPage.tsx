import { api } from '../../shared/api/client';
import { useLoad } from '../../shared/lib/hooks';
import { useApplication } from '../../shared/lib/application-context';
import { Loading, Metric, PageHeader, Badge } from '../../shared/ui/Feedback';
import { AdminLink, TaskCard, money } from './AdminUI';
export function Overview() {
  const app = useApplication(),
    load = useLoad((signal) => api('operations', {}, { signal })),
    usage = useLoad((signal) => api('usage.read', {}, { signal }));
  const company =
      app.session.tenants.find((t) => t.id === app.session.user?.tenant)?.name ?? 'Компания',
    owner = app.session.user?.operator;
  return (
    <>
      <PageHeader
        eyebrow="ПАНЕЛЬ УПРАВЛЕНИЯ"
        title={company}
        description="Настройте помощника, подключите знания и пригласите команду. Начните с нужной задачи."
      />
      <section className="admin-role-note">
        <Badge tone={owner ? 'info' : 'success'}>
          {owner ? 'Владелец платформы' : 'Администратор компании'}
        </Badge>
        <p>
          {owner
            ? 'Вы управляете платформой и выбранной компанией. Общие настройки сервера и AI-подключений находятся в отдельной группе «Платформа».'
            : 'Вы управляете своей компанией: сотрудниками, базами знаний и помощником. Сервер и API-ключи настраивает владелец платформы.'}
          {owner && (
            <>
              {' '}
              <AdminLink to="connections">Настроить AI-подключения и ключи →</AdminLink>
            </>
          )}
        </p>
      </section>
      {load.error && <Loading error={load.error} retry={load.reload} />}
      <div className="metrics-grid">
        <Metric
          label="Документы"
          value={load.data?.counts.documents ?? '—'}
          detail="В выбранной компании"
        />
        <Metric
          label="Сотрудники"
          value={load.data?.counts.users ?? '—'}
          detail="Участники компании"
        />
        <Metric
          label="В работе"
          value={load.data?.queue.length ?? '—'}
          detail="Обработка и ответы"
        />
        <Metric
          label="AI за месяц"
          value={usage.data ? money(usage.data.spentMicros) : '—'}
          detail={usage.data ? 'Из бюджета ' + money(usage.data.budgetMicros) : 'Расходы компании'}
        />
      </div>
      <section className="admin-section">
        <div className="section-heading">
          <div>
            <h2>Настройка компании</h2>
            <p>Модели, материалы, люди и расходы — каждая задача в своём разделе.</p>
          </div>
        </div>
        <div className="admin-task-grid">
          {(['assistant', 'collections', 'users', 'usage'] as const).map((to) => (
            <TaskCard key={to} to={to} />
          ))}
        </div>
      </section>
      <section className="admin-section">
        <div className="section-heading">
          <div>
            <h2>Работа с базой знаний</h2>
            <p>Загрузку и проверку отдельных файлов выполняйте в библиотеке документов.</p>
          </div>
        </div>
        <div className="admin-task-grid">
          {(['indexes', 'sync', 'quality', 'operations'] as const).map((to) => (
            <TaskCard key={to} to={to} />
          ))}
        </div>
      </section>
      {owner && (
        <section className="admin-section admin-platform-section">
          <div className="section-heading">
            <div>
              <h2>Платформа</h2>
              <p>Эти разделы доступны только владельцу. Клиенты их не видят.</p>
            </div>
          </div>
          <div className="admin-task-grid">
            {(['tenants', 'connections', 'system'] as const).map((to) => (
              <TaskCard key={to} to={to} />
            ))}
          </div>
        </section>
      )}
      <p className="muted">
        Нужны копии данных или параметры обработки? Откройте{' '}
        <AdminLink to="backups">резервные копии</AdminLink> или{' '}
        <AdminLink to="settings">параметры обработки</AdminLink>.
      </p>
    </>
  );
}
