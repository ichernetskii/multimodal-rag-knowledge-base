import { useEffect, useState } from 'react';
import { api } from '../../shared/api/client';
import { useLoad } from '../../shared/lib/hooks';
import { useApplication } from '../../shared/lib/application-context';
import { Button } from '../../shared/ui/Button';
import { Loading, PageHeader } from '../../shared/ui/Feedback';
import { statuses } from '../jobs/job-status';
const kindNames: Record<string, string> = {
  answer: 'Ответ пользователю',
  document: 'Обработка документа',
  index: 'Перестроение индекса',
  evaluation: 'Проверка качества',
  maintenance: 'Обслуживание',
  backup: 'Резервное копирование',
  restore: 'Восстановление',
  cleanup: 'Очистка',
  sync: 'Синхронизация',
};
const finished = ['complete', 'no_info', 'clarification', 'cancelled', 'failed', 'interrupted'];
export function Operations() {
  const app = useApplication(),
    load = useLoad((signal) => api('operations', {}, { signal })),
    jobs = useLoad((signal) => api('jobs.list', { pageSize: 100 }, { signal }));
  const [filter, setFilter] = useState('all');
  useEffect(() => {
    const t = setInterval(() => {
      load.reload();
      jobs.reload();
    }, 5000);
    return () => clearInterval(t);
  }, [load.reload, jobs.reload]);
  const data = load.data;
  return (
    <>
      <PageHeader
        title="Задания и очереди"
        description="Очереди и данные текущей компании. Лимиты генерации и индексации независимы."
        actions={
          <Button
            onClick={() => {
              load.reload();
              jobs.reload();
            }}
          >
            Обновить
          </Button>
        }
      />
      {!data ? (
        <Loading error={load.error} retry={load.reload} />
      ) : (
        <>
          <section className="panel">
            <h2>Нагрузка компании</h2>
            <p>
              В очередях: {data.queue.length} · Старейшее задание:{' '}
              {Math.round(data.queue.oldestAgeMs / 1000)} с · Файлы:{' '}
              {(data.dataBytes / 1024 ** 2).toFixed(1)} МиБ
            </p>
            <div className="form-grid">
              {data.queue.lanes.map((l) => (
                <div key={l.kind}>
                  <strong>{kindNames[l.kind] ?? l.kind}</strong>
                  <p>{l.length} заданий</p>
                </div>
              ))}
            </div>
            <details className="admin-details">
              <summary>Обслуживание данных</summary>
              <p>
                Удалить данные компании с истёкшим сроком хранения согласно параметрам обработки.
              </p>
              <Button
                onClick={async () => {
                  const job = await api('cleanup');
                  app.jobs.upsert(job);
                  app.jobs.watch(job);
                  app.notify('Очистка поставлена в очередь.');
                }}
              >
                Запустить очистку
              </Button>
            </details>
          </section>
          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>Последние задания</h2>
                <p>Последние 100 заданий компании. Список обновляется автоматически.</p>
              </div>
              <label>
                Показать
                <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                  <option value="all">Все задания</option>
                  <option value="active">В работе</option>
                  <option value="failed">С ошибкой</option>
                  <option value="complete">Завершённые</option>
                </select>
              </label>
            </div>
            {jobs.error && <Loading error={jobs.error} retry={jobs.reload} />}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Задание</th>
                    <th>Состояние</th>
                    <th>Ошибка / результат</th>
                    <th>Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.data?.items
                    .filter(
                      (j) =>
                        filter === 'all' ||
                        (filter === 'active'
                          ? !finished.includes(j.status)
                          : filter === 'failed'
                            ? ['failed', 'interrupted'].includes(j.status)
                            : ['complete', 'no_info', 'clarification', 'cancelled'].includes(
                                j.status,
                              )),
                    )
                    .map((j) => (
                      <tr key={j.id}>
                        <td>
                          <strong>{kindNames[j.kind] ?? j.kind}</strong>
                          <details>
                            <summary>ID задания</summary>
                            <code>{j.id}</code>
                          </details>
                        </td>
                        <td>{statuses[j.status]}</td>
                        <td>
                          {j.error}
                          <br />
                          {typeof j.result.message === 'string' ? j.result.message : ''}
                        </td>
                        <td>
                          {![
                            'complete',
                            'no_info',
                            'clarification',
                            'cancelled',
                            'failed',
                            'interrupted',
                          ].includes(j.status) ? (
                            <Button
                              onClick={async () => {
                                await api('jobs.cancel', { id: j.id });
                                jobs.reload();
                              }}
                            >
                              Отменить
                            </Button>
                          ) : (
                            ['failed', 'interrupted'].includes(j.status) && (
                              <Button
                                onClick={async () => {
                                  const next = await api('jobs.retry', { id: j.id });
                                  app.jobs.upsert(next);
                                  app.jobs.watch(next);
                                  jobs.reload();
                                }}
                              >
                                Повторить отдельной попыткой
                              </Button>
                            )
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
