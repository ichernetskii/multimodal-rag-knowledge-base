import { api } from '../../shared/api/client';
import { useApplication } from '../../shared/lib/application-context';
import { text } from '../../shared/lib/form-data';
import { bytes, date, duration, quantity } from '../../shared/lib/format';
import { useLoad, useModal } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Field, Form } from '../../shared/ui/Form';
import { Badge, Loading, Metric, PageHeader } from '../../shared/ui/Feedback';
import { Table } from '../../shared/ui/DataTable';
const recordNames: Record<string, string> = {
  check: 'Контрольные вопросы',
  collection: 'Базы знаний',
  conversation: 'Диалоги',
  document: 'Документы',
  evaluation_result: 'Результаты проверки качества',
  feedback: 'Оценки ответов',
  group: 'Группы',
  job: 'Задания',
  sync: 'Подключённые папки',
  system: 'Настройки и служебные записи',
  turn: 'Версии сообщений',
  user: 'Пользователи',
  version: 'Версии документов',
};
export function Backups() {
  const app = useApplication(),
    modal = useModal(),
    load = useLoad(async (signal) => {
      const [backups, settings] = await Promise.all([
        api('backup.list', {}, { signal }),
        api('settings.read', {}, { signal }),
      ]);
      return { backups, settings };
    });
  const d = load.data,
    s = d?.settings;
  return (
    <>
      <PageHeader
        eyebrow="СОХРАННОСТЬ ДАННЫХ"
        title="Резервные копии"
        description="Согласованные копии документов, пользователей, истории, настроек и заданий."
        actions={
          <Button
            className="primary"
            onClick={async () => {
              const result = await api('backup.create', {}, { timeoutMs: 600_000 });
              app.notify('Копия создана и проверена: ' + result.id);
              load.reload();
            }}
          >
            Создать копию
          </Button>
        }
      />
      {load.error && <Loading error={load.error} retry={load.reload} />}{' '}
      {d && s ? (
        <>
          <div className="metrics-grid three">
            <Metric
              label="Последняя копия"
              value={d.backups[0] ? date(d.backups[0].created) : 'Ещё нет'}
              detail={d.backups[0] ? bytes(d.backups[0].bytes) : 'Создайте первую копию'}
            />
            <Metric
              label="Расписание"
              value={s.backupIntervalHours ? `Каждые ${s.backupIntervalHours} ч` : 'Вручную'}
              detail={
                s.backupIntervalHours
                  ? 'Следующая: ' + date(s.nextBackup)
                  : 'Автоматическое создание отключено'
              }
            />
            <Metric
              label="Хранение"
              value={quantity(s.backupDays, 'день', 'дня', 'дней')}
              detail={`${quantity(d.backups.length, 'копия', 'копии', 'копий')} · ${bytes(d.backups.reduce((sum, b) => sum + b.bytes, 0))}`}
            />
          </div>
          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>Хранилище и расписание</h2>
                <p>Укажите каталог на другом диске, чтобы пережить сбой основного накопителя.</p>
              </div>
            </div>
            <Form
              key={s.revision}
              label="Сохранить расписание"
              submit={async (f) => {
                const hours = Number(f.get('backupIntervalHours'));
                await api('settings.save', {
                  revision: s.revision,
                  settings: {
                    backupDir: text(f, 'backupDir'),
                    backupIntervalHours: hours,
                    backupDays: Number(f.get('backupDays')),
                    nextBackup: hours ? Date.now() + hours * 3600_000 : 0,
                  },
                });
                load.reload();
                app.notify('Расписание резервного копирования сохранено.');
              }}
            >
              <Field
                label="Каталог резервных копий на сервере"
                name="backupDir"
                value={s.backupDir}
                required
                hint="Путь должен быть доступен процессу сервера на запись. Для контейнера используйте подключённый том."
              />
              <div className="form-grid">
                <Field
                  label="Интервал, часов"
                  name="backupIntervalHours"
                  type="number"
                  min={0}
                  max={8760}
                  value={s.backupIntervalHours}
                  hint="0 — создавать только вручную."
                />
                <Field
                  label="Срок хранения, дней"
                  name="backupDays"
                  type="number"
                  min={1}
                  max={36500}
                  value={s.backupDays}
                  hint="Старые копии очищаются после успешного создания новой."
                />
              </div>
            </Form>
          </section>
          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>Сохранённые копии</h2>
                <p>
                  Перед восстановлением сервер проверяет формат, SQLite, контрольную сумму и
                  оригиналы.
                </p>
              </div>
              <Button onClick={load.reload}>Обновить</Button>
            </div>
            <Table
              head={['Копия', 'Создана', 'Размер', 'Состояние', 'Действия']}
              rowKeys={d.backups.map((b) => b.id)}
              empty="Резервных копий пока нет."
              rows={d.backups.map((b) => [
                <span className="mono small-text">{b.id}</span>,
                date(b.created),
                bytes(b.bytes),
                <Badge tone={b.verified ? 'success' : 'warning'}>
                  {b.verified ? 'Проверена при создании' : 'Нет контрольной суммы'}
                </Badge>,
                <div className="actions compact">
                  <Button
                    onClick={async () => {
                      const report = await api(
                        'backup.verify',
                        { id: b.id },
                        { timeoutMs: 600_000 },
                      );
                      modal(
                        <>
                          <h2>Целостность подтверждена</h2>
                          <p className="path-text">{report.id}</p>
                          <Badge tone="success">SQLite и оригиналы в порядке</Badge>
                          <Table
                            head={['Тип данных', 'Записей']}
                            rows={report.entities.map((row) => [
                              recordNames[String(row.kind)] ?? String(row.kind),
                              String(row.count),
                            ])}
                          />
                        </>,
                      );
                    }}
                  >
                    Проверить
                  </Button>
                  <Button
                    onClick={() =>
                      modal(
                        <>
                          <p className="eyebrow">ВОССТАНОВЛЕНИЕ УСТАНОВКИ</p>
                          <h2>Восстановить копию от {date(b.created)}?</h2>
                          <div className="warning callout">
                            Текущие данные будут заменены. Сервер остановит активные задания и
                            отзовёт все сессии. Завершённые задания повторно не запускаются.
                          </div>
                          <p>
                            Перед заменой сервер сохранит текущее состояние для восстановления при
                            ошибке.
                          </p>
                          <p className="mono small-text">{b.id}</p>
                          <Form
                            label="Восстановить установку"
                            submit={async (f) => {
                              if (text(f, 'confirmation') !== 'ВОССТАНОВИТЬ')
                                throw new Error('Введите ВОССТАНОВИТЬ для подтверждения.');
                              const report = await api(
                                'backup.restore',
                                { id: b.id },
                                { timeoutMs: 600_000 },
                              );
                              modal(null);
                              app.session.signedOut();
                              app.notify(
                                'Данные восстановлены за ' +
                                  duration(report.milliseconds) +
                                  '. Войдите заново.',
                              );
                            }}
                          >
                            <Field
                              label="Введите ВОССТАНОВИТЬ"
                              name="confirmation"
                              required
                              autoComplete="off"
                            />
                          </Form>
                        </>,
                      )
                    }
                  >
                    Восстановить
                  </Button>
                </div>,
              ])}
            />
          </section>
          <div className="info-callout">
            <strong>Копия текущего формата</strong>
            <p>
              Несовместимые данные и резервные копии отклоняются с понятной ошибкой. Форматы
              разработки не преобразуются автоматически.
            </p>
          </div>
        </>
      ) : (
        !load.error && <Loading />
      )}
    </>
  );
}
