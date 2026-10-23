import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { api, uploadFile } from '../../shared/api/client';
import type { DocumentPreview } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { bytes } from '../../shared/lib/format';
import { useLoad, useModal } from '../../shared/lib/hooks';
import { Form } from '../../shared/ui/Form';
import { Badge, Loading } from '../../shared/ui/Feedback';
import { Table } from '../../shared/ui/DataTable';
const labels = {
  new: 'New document',
  update: 'New version',
  duplicate: 'Content already exists',
  unsupported: 'Unsupported format',
  limit: 'Limit exceeded',
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
  const extensions = limits.data.supported;
  async function prepare(files: File[]) {
    const request = ++sequence.current;
    setPrepared([]);
    setError('');
    setChecking(true);
    try {
      if (files.length > 100) throw new Error('Choose up to 100 files per upload.');
      const hashed = [];
      for (const file of files) {
        if (request !== sequence.current) return;
        const digest =
          file.size > maxBytes ||
          !extensions.some((extension) => file.name.toLowerCase().endsWith('.' + extension))
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
        setError(e instanceof Error ? e.message : 'Could not check the files.');
    } finally {
      if (request === sequence.current) setChecking(false);
    }
  }
  const ready = prepared.filter(
    (item) => !item.accepted && ['new', 'update'].includes(item.result.status),
  );
  return (
    <>
      <p className="eyebrow">{conversation ? 'CONVERSATION ATTACHMENTS' : 'ADD TO LIBRARY'}</p>
      <h2>{conversation ? 'Private documents' : 'Upload documents'}</h2>
      <p className="muted">
        {conversation
          ? 'Attachments are private to you and stay in this conversation.'
          : 'Choose a knowledge base and files. Duplicates and updates are shown before uploading.'}
      </p>
      <Form
        label={
          uploading
            ? 'Uploading ' + uploading
            : ready.length
              ? `Upload · ${ready.length} files`
              : 'Upload'
        }
        disabled={checking || !ready.length || (!conversation && !chosen)}
        submit={async () => {
          try {
            for (const item of ready) {
              setUploading(item.file.name);
              const { file, result } = item,
                response = await uploadFile(
                  file,
                  {
                    ...(conversation ? { conversation } : { collection: chosen }),
                    ...(result.status === 'update'
                      ? { document: result.document!, revision: result.revision! }
                      : {}),
                  },
                  {
                    progress: (done, total) =>
                      setUploading(file.name + ' · ' + Math.round((done / total) * 100) + '%'),
                  },
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
            app.notify('Files accepted. Track processing in the document list.');
            modal(null);
            after?.();
          } finally {
            setUploading('');
          }
        }}
      >
        {!conversation && (
          <label className="field">
            <span>Knowledge base</span>
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
          <strong>Choose files</strong>
          <span>Documents, images, video, and audio · up to {bytes(maxBytes)} per file</span>
          <input
            className="sr-only"
            ref={fileInput}
            type="file"
            name="files"
            multiple
            accept={extensions.map((extension) => '.' + extension).join(',')}
            onChange={(event) => void prepare(Array.from(event.target.files ?? []))}
          />
        </label>
        {checking && <Loading />}
        {error && <Loading error={error} />}{' '}
        {prepared.length > 0 && (
          <Table
            head={['File', 'Size', 'Review']}
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
                {item.accepted ? 'Accepted' : labels[item.result.status]}
              </Badge>,
            ])}
          />
        )}
        <div className="info-callout">
          <p>
            Processing runs in the background using this company's assigned models. Depending on
            your settings, text, images, and recording segments are saved. Check the result against
            the original before publication. Video is analyzed using selected segments; a speech
            transcript does not describe every sound in a recording.
          </p>
        </div>
      </Form>
    </>
  );
});
