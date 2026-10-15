import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { api, base64 } from '../../shared/api/client';
import type { DocumentPreview } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { bytes } from '../../shared/lib/format';
import { useLoad, useModal } from '../../shared/lib/hooks';
import { Form } from '../../shared/ui/Form';
import { Badge, Loading } from '../../shared/ui/Feedback';
import { Table } from '../../shared/ui/DataTable';
const labels = {
  new: 'Новый документ',
  update: 'Новая версия',
  duplicate: 'Содержимое уже есть',
  unsupported: 'Формат не поддерживается',
  limit: 'Превышен лимит',
} as const;
export const Upload = observer(function Upload({
  collection = '',
  conversation = '',
  after,
}: {
  collection?: string;
  conversation?: string;
  after?: () => void;
}) {
  const app = useApplication(),
    modal = useModal(),
    limits = useLoad((signal) => api('documents.limits', {}, { signal })),
    [chosen, setChosen] = useState(
      collection || app.bases.items.find((c) => app.bases.canEdit(c))?.id || '',
    ),
    [prepared, setPrepared] = useState<
      { file: File; result: DocumentPreview; accepted: boolean }[]
    >([]),
    [checking, setChecking] = useState(false),
    [error, setError] = useState(''),
    [uploading, setUploading] = useState(''),
    sequence = useRef(0),
    fileInput = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  if (!limits.data) return <Loading error={limits.error} retry={limits.reload} />;
  const maxBytes = limits.data.maxBytes;
  async function prepare(files: File[]) {
    const request = ++sequence.current;
    setPrepared([]);
    setError('');
    setChecking(true);
    try {
      if (files.length > 100) throw new Error('Выберите до 100 файлов за одну загрузку.');
      const hashed = [];
      for (const file of files) {
        if (request !== sequence.current) return;
        const digest =
          file.size > maxBytes || !/\.(pdf|md|markdown|txt)$/iu.test(file.name)
            ? ''
            : Array.from(
                new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
                (value) => value.toString(16).padStart(2, '0'),
              ).join('');
        hashed.push({ file, hash: digest });
      }
      if (request !== sequence.current) return;
      const results = await api('documents.preview', {
        ...(conversation ? { conversation } : { collection: chosen }),
        files: hashed.map((h) => ({ name: h.file.name, bytes: h.file.size, hash: h.hash })),
      });
      if (request === sequence.current)
        setPrepared(
          hashed.map((item, index) => ({
            file: item.file,
            result: results[index]!,
            accepted: false,
          })),
        );
    } catch (e) {
      if (request === sequence.current)
        setError(e instanceof Error ? e.message : 'Не удалось проверить файлы.');
    } finally {
      if (request === sequence.current) setChecking(false);
    }
  }
  const ready = prepared.filter(
    (item) => !item.accepted && ['new', 'update'].includes(item.result.status),
  );
  return (
    <>
      <p className="eyebrow">{conversation ? 'ВЛОЖЕНИЯ ДИАЛОГА' : 'ПОПОЛНЕНИЕ БИБЛИОТЕКИ'}</p>
      <h2>{conversation ? 'Личные документы' : 'Загрузка документов'}</h2>
      <p className="muted">
        {conversation
          ? 'Вложения доступны только вам и остаются в этом диалоге.'
          : 'Выберите базу и файлы. Совпадения и обновления будут показаны до загрузки.'}
      </p>
      <Form
        label={
          uploading
            ? 'Загрузка ' + uploading
            : ready.length
              ? `Загрузить · ${ready.length} файлов`
              : 'Загрузить'
        }
        disabled={checking || !ready.length || (!conversation && !chosen)}
        submit={async () => {
          try {
            for (const item of ready) {
              setUploading(item.file.name);
              const { file, result } = item,
                response = await api(
                  'documents.upload',
                  {
                    ...(conversation ? { conversation } : { collection: chosen }),
                    name: file.name,
                    base64: await base64(file),
                    ...(result.status === 'update'
                      ? { document: result.document!, revision: result.revision! }
                      : {}),
                  },
                  { timeoutMs: 120_000 },
                );
              if (response.job) {
                app.jobs.upsert(response.job);
                app.jobs.watch(response.job);
              }
              setPrepared((previous) =>
                previous.map((value) =>
                  value.file === file ? { ...value, accepted: true } : value,
                ),
              );
            }
            app.notify('Файлы приняты. Ход обработки доступен в списке документов.');
            modal(null);
            after?.();
          } finally {
            setUploading('');
          }
        }}
      >
        {!conversation && (
          <label className="field">
            <span>База знаний</span>
            <select
              value={chosen}
              onChange={(event) => {
                sequence.current++;
                setChecking(false);
                setChosen(event.target.value);
                setPrepared([]);
                if (fileInput.current) fileInput.current.value = '';
              }}
            >
              {app.bases.items
                .filter((c) => app.bases.canEdit(c))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="file-drop">
          <span className="upload-symbol" aria-hidden="true">
            ↑
          </span>
          <strong>Выберите файлы</strong>
          <span>PDF, Markdown и TXT · до {bytes(maxBytes)} на файл</span>
          <input
            className="sr-only"
            ref={fileInput}
            type="file"
            name="files"
            multiple
            accept=".pdf,.md,.markdown,.txt"
            onChange={(event) => void prepare(Array.from(event.target.files ?? []))}
          />
        </label>
        {checking && <Loading />}
        {error && <Loading error={error} />}{' '}
        {prepared.length > 0 && (
          <Table
            head={['Файл', 'Размер', 'Проверка']}
            rowKeys={prepared.map((item, index) => item.file.name + '-' + index)}
            rows={prepared.map((item) => [
              item.file.name,
              bytes(item.file.size),
              <Badge
                tone={
                  item.accepted
                    ? 'success'
                    : item.result.status === 'new'
                      ? 'success'
                      : item.result.status === 'update'
                        ? 'info'
                        : item.result.status === 'duplicate'
                          ? 'neutral'
                          : 'warning'
                }
              >
                {item.accepted ? 'Принят' : labels[item.result.status]}
              </Badge>,
            ])}
          />
        )}
        <div className="info-callout">
          <p>
            Индексация выполняется в фоне. Страницы с OCR и предупреждениями потребуют проверки
            перед публикацией.
          </p>
        </div>
      </Form>
    </>
  );
});
