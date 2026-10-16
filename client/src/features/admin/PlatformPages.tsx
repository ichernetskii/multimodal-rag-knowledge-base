import { api } from '../../shared/api/client';
import { useApplication } from '../../shared/lib/application-context';
import { useLoad } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Field, Form } from '../../shared/ui/Form';
import { Badge, Loading, Metric, PageHeader } from '../../shared/ui/Feedback';
import { text } from '../../shared/lib/form-data';
export function Tenants() {
  const app = useApplication(),
    load = useLoad((signal) => api('tenants.list', {}, { signal }));
  return (
    <>
      <PageHeader
        title="Компании клиентов"
        description="Общая SaaS-установка: у каждой компании свои сотрудники, документы, настройки и расходы."
      />
      <div className="admin-role-note">
        <p>
          Создание компании не выдаёт её сотрудникам права владельца платформы. Для работы с её
          материалами переключитесь в компанию.
        </p>
      </div>
      <section className="panel">
        <div className="section-heading">
          <h2>Все компании</h2>
          <Button onClick={load.reload}>Обновить</Button>
        </div>
        {load.error && <Loading error={load.error} retry={load.reload} />}
        <div className="admin-tenant-grid">
          {load.data?.map((t) => (
            <article className="admin-tenant-card" key={t.id}>
              <div>
                <h3>{t.name}</h3>
                <Badge tone={t.blocked ? 'danger' : 'success'}>
                  {t.blocked ? 'Приостановлена' : 'Активна'}
                </Badge>
              </div>
              <p>
                {t.id === app.session.user?.tenant
                  ? 'Сейчас выбрана'
                  : app.session.tenants.some((m) => m.id === t.id)
                    ? 'Вы можете открыть управление этой компанией'
                    : 'У вас нет членства для просмотра материалов этой компании'}
              </p>
              <div className="actions">
                {app.session.tenants.some((m) => m.id === t.id) && (
                  <Button
                    disabled={t.blocked}
                    onClick={async () => {
                      await app.switchCompany(t.id);
                      app.navigation.navigate('admin', 'overview');
                    }}
                  >
                    Управлять компанией
                  </Button>
                )}
                <Button
                  className={t.blocked ? '' : 'danger'}
                  onClick={async () => {
                    await api('tenants.update', {
                      id: t.id,
                      revision: t.revision,
                      blocked: !t.blocked,
                    });
                    load.reload();
                    await app.session.refresh();
                  }}
                >
                  {t.blocked ? 'Возобновить доступ' : 'Приостановить доступ'}
                </Button>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="panel">
        <h2>Добавить компанию</h2>
        <p>
          Будут созданы отдельные настройки, каталог моделей и доступ владельца платформы.
          Сотрудников пригласите в разделе «Команда и роли» этой компании.
        </p>
        <Form
          label="Создать компанию"
          submit={async (f) => {
            await api('tenants.create', { name: text(f, 'name') });
            load.reload();
            await app.session.refresh();
          }}
        >
          <Field name="name" label="Название компании" required maxLength={200} />
        </Form>
      </section>
    </>
  );
}
const workers: Record<string, string> = {
  answer: 'Ответы пользователям',
  document: 'Обработка и индексация',
  evaluation: 'Проверка качества',
  maintenance: 'Обслуживание и резервные копии',
  all: 'Все типы заданий',
};
export function System() {
  const load = useLoad((signal) => api('diagnostics', {}, { signal })),
    d = load.data;
  return (
    <>
      <PageHeader
        title="Состояние сервера"
        description="Общие зависимости и вычислительные ресурсы установки. Раздел доступен только владельцу платформы."
        actions={<Button onClick={load.reload}>Проверить снова</Button>}
      />
      {!d ? (
        <Loading error={load.error} retry={load.reload} />
      ) : (
        <>
          <div className="metrics-grid">
            <Metric
              label="PostgreSQL"
              value={d.postgres ? 'Работает' : 'Ошибка'}
              detail="Данные компаний и очередь"
            />
            <Metric
              label="S3"
              value={d.storage ? 'Работает' : 'Ошибка'}
              detail="Файлы и производные материалы"
            />
            <Metric
              label="Redis"
              value={d.redis ? 'Работает' : 'Недоступен'}
              detail="Кеш; задания сохраняются в PostgreSQL"
            />
            <Metric
              label="Обработчики"
              value={d.workers.length}
              detail="Недавние сигналы работоспособности"
            />
          </div>
          <section className="panel">
            <h2>Фоновые обработчики</h2>
            <div className="admin-status-list">
              {d.workers.map((w) => (
                <div key={w.kind}>
                  <strong>{workers[w.kind] ?? w.kind}</strong>
                  <span>Сигнал: {new Date(w.lastSeen).toLocaleTimeString()}</span>
                  <Badge tone="success">На связи</Badge>
                </div>
              ))}
            </div>
            {!d.workers.length && (
              <p role="alert">Нет сигналов от обработчиков. Проверьте запуск Docker-воркеров.</p>
            )}
          </section>
          <section className="panel">
            <h2>Материалы и распознавание</h2>
            <div className="admin-status-list">
              {Object.entries({
                'Текст PDF': d.extraction.pdf,
                'OCR изображений': d.extraction.ocr,
                FFmpeg: d.media.ffmpeg,
                Whisper: d.media.whisper && d.media.model,
              }).map(([name, ready]) => (
                <div key={name}>
                  <strong>{name}</strong>
                  <Badge tone={ready ? 'success' : 'danger'}>
                    {ready ? 'Готово' : 'Требует настройки'}
                  </Badge>
                </div>
              ))}
            </div>
          </section>
          <details className="panel admin-details">
            <summary>Ресурсы и технические сведения</summary>
            <p>
              CPU: {d.hardware.cpu} · {d.hardware.cores} ядер
            </p>
            <p>
              Оперативная память контейнерного окружения:{' '}
              {(d.hardware.totalMemory / 1024 ** 3).toFixed(1)} ГиБ, свободно{' '}
              {(d.hardware.freeMemory / 1024 ** 3).toFixed(1)} ГиБ
            </p>
            <p>Свободное место: {(d.freeBytes / 1024 ** 3).toFixed(1)} ГиБ</p>
            <p className="muted">
              Лимиты Docker и серверные секреты задаются в конфигурации развёртывания.
            </p>
          </details>
        </>
      )}
    </>
  );
}
