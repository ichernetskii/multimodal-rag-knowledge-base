import { useState } from 'react';
import { api } from '../../shared/api/client';
import type { SyncFolder, SyncPreview } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { text, option } from '../../shared/lib/form-data';
import { date, quantity } from '../../shared/lib/format';
import { useLoad, useModal } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Field, Form, Select } from '../../shared/ui/Form';
import { Badge, EmptyState, Loading, PageHeader } from '../../shared/ui/Feedback';
import { Table, Pagination } from '../../shared/ui/DataTable';
const policies = {
  keep: 'Сохранить документ',
  exclude: 'Исключить из поиска',
  delete: 'Окончательно удалить',
} as const;
const changeNames: Record<string, string> = {
  new: 'Новый документ',
  update: 'Новая версия',
  unchanged: 'Без изменений',
  removed: 'Файл удалён',
  unsupported: 'Не поддерживается',
  limit: 'Превышен лимит',
};
function Changes({ preview, id, done }: { preview: SyncPreview; id: string; done: () => void }) {
  const [page, setPage] = useState(1),
    counts = preview.files.reduce<Record<string, number>>((all, file) => {
      all[file.status] = (all[file.status] ?? 0) + 1;
      return all;
    }, {});
  return (
    <>
      <h2>Изменения папки</h2>
      <div className="actions">
        {Object.entries(counts).map(([key, count]) => (
          <Badge
            key={key}
            tone={key === 'removed' ? 'warning' : key === 'new' ? 'success' : 'neutral'}
          >
            {changeNames[key]}: {count}
          </Badge>
        ))}
      </div>
      <p>
        Политика удалённых файлов: <strong>{policies[preview.policy]}</strong>.
      </p>
      <Table
        head={['Файл', 'Изменение']}
        rowKeys={preview.files.slice((page - 1) * 25, page * 25).map((f) => f.path)}
        rows={preview.files
          .slice((page - 1) * 25, page * 25)
          .map((f) => [
            <span className="path-text">{f.path}</span>,
            changeNames[f.status] ?? f.status,
          ])}
      />
      <Pagination page={page} pageSize={25} total={preview.files.length} onChange={setPage} />
      <Button
        className={preview.policy === 'delete' && counts.removed ? 'danger' : 'primary'}
        onClick={async () => {
          await api('sync.run', { id }, { timeoutMs: 600_000 });
          done();
        }}
      >
        Применить изменения
      </Button>
    </>
  );
}
export function Sync() {
  const app = useApplication(),
    modal = useModal(),
    load = useLoad((signal) => api('sync.list', {}, { signal }));
  const edit = (folder?: SyncFolder) =>
    modal(
      <>
        <p className="eyebrow">СИНХРОНИЗАЦИЯ</p>
        <h2>{folder ? 'Настройки папки' : 'Подключить локальную папку'}</h2>
        <Form
          label={folder ? 'Сохранить' : 'Подключить папку'}
          submit={async (f) => {
            await api('sync.save', {
              ...(folder ? { id: folder.id, revision: folder.revision } : {}),
              path: text(f, 'path'),
              collection: text(f, 'collection'),
              policy: option(f, 'policy', ['keep', 'exclude', 'delete'] as const),
              intervalMinutes: Number(f.get('intervalMinutes')),
            });
            modal(null);
            load.reload();
          }}
        >
          <Field
            label="Каталог на сервере"
            name="path"
            value={folder?.path}
            required
            readOnly={!!folder}
            hint="Папка находится на машине сервера. В контейнере она должна быть подключена как том."
          />
          <Select
            label="База знаний"
            name="collection"
            value={folder?.collection}
            options={
              folder
                ? [
                    [
                      folder.collection,
                      app.bases.items.find((c) => c.id === folder.collection)?.name ??
                        folder.collection,
                    ],
                  ]
                : app.bases.items.map((c) => [c.id, c.name])
            }
          />
          <Select
            label="Если исходный файл удалён"
            name="policy"
            value={folder?.policy ?? 'keep'}
            options={Object.entries(policies)}
            hint="Выберите политику явно. При окончательном удалении исчезнут оригинал и производные данные."
          />
          <Field
            label="Интервал, минут"
            name="intervalMinutes"
            type="number"
            min={0}
            max={525600}
            value={folder?.intervalMinutes ?? 0}
            hint="0 — запускать только вручную."
          />
        </Form>
      </>,
    );
  return (
    <>
      <PageHeader
        eyebrow="ИСТОЧНИКИ ДАННЫХ"
        title="Синхронизация папок"
        description="Подключайте выбранные папки сервера, просматривайте изменения и задавайте расписание."
        actions={
          <Button className="primary" disabled={!app.bases.items.length} onClick={() => edit()}>
            + Подключить папку
          </Button>
        }
      />
      {load.error && <Loading error={load.error} retry={load.reload} />}{' '}
      {!load.data ? (
        <Loading />
      ) : load.data.length ? (
        load.data.map((s) => (
          <section className="panel sync-card" key={s.id}>
            <div className="section-heading">
              <div>
                <span className="eyebrow">
                  {app.bases.items.find((c) => c.id === s.collection)?.name ?? 'База знаний'}
                </span>
                <h2 className="path-text">{s.path}</h2>
              </div>
              <Badge tone={s.intervalMinutes ? 'success' : 'neutral'}>
                {s.intervalMinutes ? `Каждые ${s.intervalMinutes} мин` : 'Вручную'}
              </Badge>
            </div>
            <div className="sync-details">
              <span>
                Удаление: <strong>{policies[s.policy]}</strong>
              </span>
              <span>
                Отслеживается:{' '}
                <strong>
                  {quantity(Object.keys(s.mapping).length, 'файл', 'файла', 'файлов')}
                </strong>
              </span>
              {s.intervalMinutes > 0 && <span>Следующий запуск: {date(s.nextRun)}</span>}
            </div>
            <div className="card-footer">
              <div className="actions">
                <Button
                  className="primary"
                  onClick={async () => {
                    const preview = await api('sync.preview', { id: s.id }, { timeoutMs: 600_000 });
                    modal(
                      <Changes
                        preview={preview}
                        id={s.id}
                        done={() => {
                          modal(null);
                          load.reload();
                          app.notify(
                            'Изменения применены. Обработка документов поставлена в очередь.',
                          );
                        }}
                      />,
                    );
                  }}
                >
                  Просмотреть изменения
                </Button>
                <Button
                  onClick={async () => {
                    await api('sync.run', { id: s.id }, { timeoutMs: 600_000 });
                    load.reload();
                    app.notify('Синхронизация завершена. Документы обрабатываются в фоне.');
                  }}
                >
                  Запустить сейчас
                </Button>
                <Button onClick={() => edit(s)}>Настроить</Button>
              </div>
              <Button
                className="text-danger"
                onClick={() =>
                  modal(
                    <>
                      <h2>Отключить папку?</h2>
                      <p>
                        Расписание будет удалено. Уже загруженные документы сохранятся в базе
                        знаний.
                      </p>
                      <Button
                        className="danger"
                        onClick={async () => {
                          await api('sync.delete', { id: s.id, revision: s.revision });
                          modal(null);
                          load.reload();
                        }}
                      >
                        Отключить
                      </Button>
                    </>,
                  )
                }
              >
                Отключить
              </Button>
            </div>
          </section>
        ))
      ) : (
        <section className="panel">
          <EmptyState
            title="Нет подключённых папок"
            description={
              app.bases.items.length
                ? 'Выберите каталог сервера и базу, в которую нужно загружать документы.'
                : 'Сначала создайте базу знаний в разделе «Базы и доступ».'
            }
          />
        </section>
      )}
      <div className="info-callout">
        <strong>Переименование сохраняет документ</strong>
        <p>
          Синхронизация сопоставляет содержимое и устойчивые идентификаторы. Личные вложения
          диалогов в неё не входят.
        </p>
      </div>
    </>
  );
}
