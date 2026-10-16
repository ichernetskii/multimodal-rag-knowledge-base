import { useEffect } from 'react';
import { api } from '../../shared/api/client';
import { useLoad, useModal } from '../../shared/lib/hooks';
import { useApplication } from '../../shared/lib/application-context';
import { Button } from '../../shared/ui/Button';
import { Loading, PageHeader } from '../../shared/ui/Feedback';
export function Backups() {
  const app = useApplication(),
    modal = useModal(),
    load = useLoad((signal) => api('backup.list', {}, { signal }));
  useEffect(() => {
    const t = setInterval(load.reload, 5000);
    return () => clearInterval(t);
  }, [load.reload]);
  return (
    <>
      <PageHeader
        title="Резервные копии компании"
        description="Согласованные данные PostgreSQL и отдельные копии файлов S3. Восстановление затрагивает выбранную компанию."
        actions={
          <Button
            onClick={async () => {
              const job = await api('backup.create');
              app.jobs.upsert(job);
              app.jobs.watch(job);
              app.notify('Создание копии поставлено в очередь.');
              load.reload();
            }}
          >
            Создать копию
          </Button>
        }
      />
      {load.error && <Loading error={load.error} retry={load.reload} />}
      <section className="panel">
        <table>
          <thead>
            <tr>
              <th>Создана</th>
              <th>Размер</th>
              <th>Проверена</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {load.data?.map((b) => (
              <tr key={b.id}>
                <td>
                  {new Date(b.created).toLocaleString()}
                  <br />
                  <code>{b.id}</code>
                </td>
                <td>{(b.bytes / 1024 ** 2).toFixed(1)} МиБ</td>
                <td>{b.verified ? 'Да' : 'Ещё нет'}</td>
                <td>
                  <Button
                    onClick={async () => {
                      const r = await api('backup.verify', { id: b.id });
                      app.notify('Проверка: ' + r.integrity);
                    }}
                  >
                    Проверить
                  </Button>
                  <Button
                    disabled={!b.verified}
                    onClick={() =>
                      modal(
                        <>
                          <h2>Восстановить компанию?</h2>
                          <p>
                            Текущие данные выбранной компании будут заменены этой копией.
                            Выполняющиеся задания остановятся. Другие компании продолжат работать.
                          </p>
                          <Button
                            className="danger"
                            onClick={async () => {
                              const job = await api('backup.restore', { id: b.id });
                              app.jobs.upsert(job);
                              app.jobs.watch(job);
                              modal(null);
                              app.notify('Восстановление поставлено в очередь.');
                            }}
                          >
                            Восстановить
                          </Button>
                        </>,
                      )
                    }
                  >
                    Восстановить
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {load.data?.length === 0 && <p>Копий пока нет.</p>}
      </section>
    </>
  );
}
