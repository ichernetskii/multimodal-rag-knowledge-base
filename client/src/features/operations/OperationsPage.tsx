import { useState } from 'react';
import { api } from '../../shared/api/client';
import { downloadJson } from '../../shared/lib/download-json';
import type { Diagnostics } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { bytes, date, duration, quantity } from '../../shared/lib/format';
import { useLoad, usePolling } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Check, Form } from '../../shared/ui/Form';
import { Badge, Loading, Metric, PageHeader } from '../../shared/ui/Feedback';
import { Table } from '../../shared/ui/DataTable';
import { statuses } from '../jobs/job-status';
const jobNames = {
  answer: 'Ответ в чате',
  document: 'Обработка документа',
  evaluation: 'Контроль качества',
} as const;
export function Operations() {
  const app = useApplication(),
    load = useLoad((signal) => api('operations', {}, { signal })),
    [diagnostics, setDiagnostics] = useState<Diagnostics>();
  usePolling(load.reload);
  const d = load.data,
    s = d?.settings;
  return (
    <>
      <PageHeader
        eyebrow="ОБЗОР УСТАНОВКИ"
        title="Рабочее пространство"
        description="Состояние сервера, ресурсы и фоновые процессы. Данные обновляются каждые 5 секунд."
        actions={
          <>
            <Button onClick={load.reload}>Обновить</Button>
            <Button
              className="primary"
              onClick={async () =>
                setDiagnostics(await api('diagnostics', {}, { timeoutMs: 120_000 }))
              }
            >
              Проверить готовность
            </Button>
          </>
        }
      />
      {load.error && <Loading error={load.error} retry={load.reload} />}{' '}
      {d && s ? (
        <>
          <div className="status-strip">
            <Badge tone={d.maintenance ? 'warning' : s.pauseIntake ? 'warning' : 'success'}>
              {d.maintenance
                ? 'Техническое обслуживание'
                : s.pauseIntake
                  ? 'Приём заданий приостановлен'
                  : 'Приём заданий открыт'}
            </Badge>
            <span>
              В очереди: <strong>{d.queue.length}</strong>
            </span>
            <span>
              В работе: <strong>{d.running.length}</strong>
            </span>
            <small>SQLite · локальное хранение</small>
          </div>
          <div className="metrics-grid">
            <Metric
              label="Документы"
              value={d.counts.documents}
              detail={quantity(d.counts.collections, 'база знаний', 'базы знаний', 'баз знаний')}
            />
            <Metric
              label="Пользователи"
              value={d.counts.users}
              detail={quantity(d.counts.conversations, 'диалог', 'диалога', 'диалогов')}
            />
            <Metric
              label="Время ответа"
              value={d.response.samples ? duration(d.response.meanMs) : '—'}
              detail={
                d.response.samples
                  ? `${quantity(d.response.samples, 'ответ', 'ответа', 'ответов')} за ${d.response.windowHours} ч`
                  : 'За последние 24 часа ответов нет'
              }
            />
            <Metric
              label="Ошибки генерации"
              value={d.response.samples ? (d.response.errorRate * 100).toFixed(1) + '%' : '—'}
              detail="За последние 24 часа"
            />
          </div>
          <div className="dashboard-grid">
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>Ресурсы сервера</h2>
                  <p>Измеренные показатели текущей установки</p>
                </div>
                <Badge>CPU · {d.cpu.cores} ядер</Badge>
              </div>
              <div className="resource-grid">
                <div>
                  <span>Оперативная память процесса</span>
                  <strong>{bytes(d.memory.process.rss)}</strong>
                  <progress
                    aria-label="Занятая системная память"
                    max={d.memory.total}
                    value={d.memory.total - d.memory.free}
                  />
                  <small>
                    Свободно {bytes(d.memory.free)} из {bytes(d.memory.total)}
                  </small>
                </div>
                <div>
                  <span>Свободное место на диске</span>
                  <strong>{bytes(d.freeBytes)}</strong>
                  <small>Резерв для работы: {bytes(s.minFreeBytes)}</small>
                  <Badge tone={d.freeBytes < s.minFreeBytes ? 'danger' : 'success'}>
                    {d.freeBytes < s.minFreeBytes ? 'Недостаточно места' : 'Достаточно места'}
                  </Badge>
                </div>
                <div>
                  <span>Средняя нагрузка CPU</span>
                  <strong>{(d.cpu.load[0] ?? 0).toFixed(2)}</strong>
                  <small>За 1 минуту · это нагрузка ОС, не процент CPU</small>
                </div>
              </div>
              <div className="storage-line">
                <span>
                  Данные SQLite <strong>{bytes(d.dataBytes)}</strong>
                </span>
                <span>
                  Кеш ответов <strong>{bytes(d.cacheBytes)}</strong>
                </span>
                <span>
                  SSE-соединения <strong>{d.sse.streams}</strong>
                </span>
              </div>
            </section>
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>Очереди</h2>
                  <p>Без расчётного времени ожидания</p>
                </div>
                <Badge tone={s.pauseQueue ? 'warning' : 'success'}>
                  {s.pauseQueue ? 'Пауза' : 'Запущены'}
                </Badge>
              </div>
              <div className="queue-list">
                {(['answer', 'document', 'evaluation'] as const).map((kind) => {
                  const lane = d.queue.lanes.find((l) => l.kind === kind);
                  return (
                    <div key={kind}>
                      <span className="queue-dot" />
                      <span>
                        <strong>{jobNames[kind]}</strong>
                        <small>
                          {lane
                            ? `Старейшее ждёт ${duration(lane.oldestAgeMs)}`
                            : 'Очередь свободна'}
                        </small>
                      </span>
                      <strong>{lane?.length ?? 0}</strong>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>Управление обработкой</h2>
                <p>
                  Пауза очередей останавливает запуск новых заданий. Уже выполняющиеся продолжают
                  работу.
                </p>
              </div>
            </div>
            <Form
              key={`${s.pauseIndexing}-${s.pauseQueue}-${s.pauseIntake}`}
              label="Применить"
              className="controls-form"
              submit={async (f) => {
                await api('settings.save', {
                  revision: load.data!.settings.revision,
                  settings: {
                    pauseIndexing: f.has('pauseIndexing'),
                    pauseQueue: f.has('pauseQueue'),
                    pauseIntake: f.has('pauseIntake'),
                  },
                });
                load.reload();
              }}
            >
              <div className="check-grid">
                <Check
                  label="Приостановить индексацию"
                  name="pauseIndexing"
                  checked={s.pauseIndexing}
                  hint="Поиск получает собственный ресурс embedding."
                />
                <Check
                  label="Приостановить очереди"
                  name="pauseQueue"
                  checked={s.pauseQueue}
                  hint="Не запускать следующие задания."
                />
                <Check
                  label="Закрыть приём заданий"
                  name="pauseIntake"
                  checked={s.pauseIntake}
                  hint="Документы и история остаются доступны."
                />
              </div>
            </Form>
          </section>
          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>Работающие задания</h2>
                <p>Состояние обработки сохраняется на сервере.</p>
              </div>
              <Badge>{d.running.length}</Badge>
            </div>
            <Table
              head={['Задание', 'Состояние', 'Начало', 'Действия']}
              rowKeys={d.running.map((j) => j.id)}
              empty="Сейчас нет работающих заданий."
              rows={d.running.map((j) => [
                <div>
                  <strong>{jobNames[j.kind]}</strong>
                  <small className="mono">{j.id.slice(0, 8)}</small>
                </div>,
                <Badge tone="info">
                  {statuses[j.status]}
                  {j.payload.paused ? ' · пауза' : ''}
                </Badge>,
                date(j.created),
                <Button
                  onClick={async () => {
                    await api('jobs.cancel', { id: j.id });
                    load.reload();
                  }}
                >
                  Отменить
                </Button>,
              ])}
            />
          </section>
          <div className="dashboard-grid">
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>Резервное копирование</h2>
                  <p>
                    {d.backups[0]
                      ? 'Последняя копия: ' + date(d.backups[0].created)
                      : 'Сохранённых копий пока нет'}
                  </p>
                </div>
                <Badge tone={d.backups[0]?.verified ? 'success' : 'warning'}>
                  {d.backups[0]?.verified ? 'Проверена' : 'Требует внимания'}
                </Badge>
              </div>
              <p className="muted">
                {s.backupIntervalHours
                  ? `Автоматически каждые ${s.backupIntervalHours} ч`
                  : 'Автоматическое расписание отключено'}
              </p>
              <Button onClick={() => app.navigation.navigate('admin', 'backups')}>
                Управлять копиями →
              </Button>
            </section>
            <section className="panel">
              <h2>Хранение и очистка</h2>
              <p className="muted">
                Очистка учитывает сроки хранения и сохраняет данные незавершённых заданий.
              </p>
              <Button
                onClick={async () => {
                  const result = await api('cleanup');
                  app.notify(`Очистка завершена. Удалено записей: ${result.removed}.`);
                  load.reload();
                }}
              >
                Очистить по срокам хранения
              </Button>
            </section>
          </div>
        </>
      ) : (
        !load.error && <Loading />
      )}
      {diagnostics && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Результат диагностики</h2>
              <p>{diagnostics.hardware.cpu}</p>
            </div>
            <Button onClick={() => downloadJson(diagnostics, 'diagnostics.json')}>
              Скачать отчёт
            </Button>
          </div>
          <div className="diagnostic-grid">
            {[
              ['Embedding', diagnostics.dependencies.embedding],
              ['Генерация', diagnostics.dependencies.generation],
              ['Обработка PDF', diagnostics.extraction.pdf],
              ['Локальный OCR', diagnostics.extraction.ocr],
              ['Совместимость индекса', diagnostics.indexCompatible],
              ['Запись в каталог', diagnostics.directoryWritable],
              ['Целостность SQLite', diagnostics.sqliteIntegrity === 'ok'],
              ['Приём новых заданий', diagnostics.ready],
            ].map(([label, ok]) => (
              <div key={String(label)}>
                <span>{label}</span>
                <Badge tone={ok ? 'success' : 'danger'}>{ok ? 'Готово' : 'Проверить'}</Badge>
              </div>
            ))}
          </div>
          <p className="path-text">{diagnostics.dataDir}</p>
        </section>
      )}
    </>
  );
}
