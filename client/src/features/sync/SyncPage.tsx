import { api } from '../../shared/api/client';
import { useLoad } from '../../shared/lib/hooks';
import { text } from '../../shared/lib/form-data';
import { Form, Field } from '../../shared/ui/Form';
import { PageHeader, Loading } from '../../shared/ui/Feedback';
import { Button } from '../../shared/ui/Button';
export function Sync() {
  const load = useLoad((signal) => api('sync.list', {}, { signal })),
    bases = useLoad((signal) => api('collections.list', {}, { signal }));
  return (
    <>
      <PageHeader
        title="Синхронизация папок"
        description="CLI читает папку на компьютере клиента и отправляет изменения через API. Сервер не обращается к диску клиента."
      />
      <section className="panel">
        <Form
          label="Создать подключение"
          submit={async (f) => {
            await api('sync.save', {
              path: text(f, 'path'),
              collection: text(f, 'collection'),
              policy: text(f, 'policy') as 'keep' | 'exclude' | 'delete',
              intervalMinutes: Number(f.get('intervalMinutes')),
            });
            load.reload();
          }}
        >
          <Field label="Название / путь папки на компьютере клиента" name="path" required />
          <label>
            База знаний
            <select name="collection" required>
              {bases.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Если файл удалён локально
            <select name="policy">
              <option value="keep">Сохранить в базе</option>
              <option value="exclude">Исключить из поиска</option>
              <option value="delete">Удалить из базы</option>
            </select>
          </label>
          <Field
            label="Интервал проверки, минут"
            name="intervalMinutes"
            type="number"
            value={5}
            min={1}
          />
        </Form>
      </section>
      {load.error && <Loading error={load.error} retry={load.reload} />}
      <section className="panel">
        {load.data?.map((c) => (
          <article key={c.id}>
            <h2>{c.path}</h2>
            <p>
              Последний отчёт: {new Date(c.nextRun).toLocaleString()} · Файлов:{' '}
              {Object.keys(c.mapping).length}
            </p>
            <p>На компьютере с папкой выполните:</p>
            <pre>
              <code>yarn cli sync {c.id} /path/to/folder --watch</code>
            </pre>
            <Button
              onClick={async () => {
                await api('sync.delete', { id: c.id, revision: c.revision });
                load.reload();
              }}
            >
              Отключить синхронизацию
            </Button>
          </article>
        ))}
      </section>
    </>
  );
}
