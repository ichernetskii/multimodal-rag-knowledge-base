import { useEffect, useState } from 'react';
import { api, tenantUrl } from '../../shared/api/client';
import { terminal, type DocumentDetails } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { date, quantity } from '../../shared/lib/format';
import { text } from '../../shared/lib/form-data';
import { useLoad, useModal, usePolling } from '../../shared/lib/hooks';
import { canEditDocument } from '../../shared/lib/permissions';
import { Button } from '../../shared/ui/Button';
import { Form } from '../../shared/ui/Form';
import { Badge, Loading } from '../../shared/ui/Feedback';
import { MediaPreview } from './MediaPreview';
import { Compare } from './CompareVersionsDialog';
import { ReplaceDocument } from './ReplaceVersionDialog';
import { DocumentFind, HighlightedText } from './DocumentFind';
import { warningNames } from './material-warnings';
import { statuses } from '../jobs/job-status';
const versionStates = {
  ready: 'Indexed',
  review: 'Review required',
  pending: 'Processing',
} as const;
const windowSize = 12000;
function PageText({
  data,
  page,
  offset,
  query,
  editing,
  setEditing,
  navigate,
  corrected,
}: {
  data: DocumentDetails;
  page: number;
  offset: number;
  query: string;
  editing: boolean;
  setEditing: (value: boolean) => void;
  navigate: (page: number, offset: number) => void;
  corrected: () => void;
}) {
  const app = useApplication();
  const load = useLoad(
    (signal) =>
      api(
        'documents.page',
        {
          id: data.document.id,
          version: data.version.id,
          page,
          offset,
          limit: windowSize,
        },
        { signal },
      ),
    [data.document.id, data.version.id, page, offset],
  );
  if (!load.data || load.loading) return <Loading error={load.error} retry={load.reload} />;
  if (load.error) return <Loading error={load.error} retry={load.reload} />;
  const part = load.data;
  return (
    <>
      <div className="document-page-meta">
        <Badge tone={part.method === 'ocr' ? 'warning' : 'neutral'}>
          {
            {
              text: 'Material text',
              ocr: 'OCR text',
              vision: 'Visual material',
              speech: 'Audio material',
            }[part.method]
          }
        </Badge>
        {part.warnings.map((warning) => (
          <Badge key={warning} tone="warning">
            {warningNames[warning] ?? warning}
          </Badge>
        ))}
      </div>
      <div className={'document-reader' + (part.media ? ' document-reader-media' : '')}>
        {part.media && (
          <section className="document-original">
            <h3>Original</h3>
            <MediaPreview
              document={data.document.id}
              version={data.version.id}
              media={part.media}
            />
          </section>
        )}
        <section className="document-processed">
          <h3>{part.media ? 'Saved processing text' : 'Read material'}</h3>
          {part.preparedText && (
            <p className="muted">
              {part.preparedText.kind === 'transcript' ? 'Transcript' : 'Description'} prepared by
              model {part.preparedText.model} · {date(part.preparedText.created)}.
              {part.warnings.includes('USER_CORRECTED') ? ' Text corrected by an editor.' : ''}{' '}
              Changing the search model does not regenerate this text.
            </p>
          )}
          {part.totalCharacters > windowSize && (
            <p className="muted" role="status">
              Characters {part.offset + 1}–{part.nextOffset} of{' '}
              {part.totalCharacters.toLocaleString('en-US')}. Large text loads in bounded windows.
            </p>
          )}
          {editing ? (
            <Form
              protectChanges
              key={data.version.id + ':' + part.number + ':' + part.offset}
              label={'Save correction'}
              submit={async (form) => {
                await api('documents.correct', {
                  id: data.document.id,
                  revision: data.document.revision,
                  version: data.version.id,
                  page: part.number,
                  text: text(form, 'correctedText'),
                  range: { start: part.offset, end: part.nextOffset },
                });
                setEditing(false);
                corrected();
                load.reload();
                app.notify('Correction saved. Review the text before publishing.');
              }}
            >
              <label>
                {part.totalCharacters > part.text.length
                  ? 'Correct this text window'
                  : 'Corrected text'}
                <textarea
                  name="correctedText"
                  defaultValue={part.text}
                  rows={14}
                  required={part.totalCharacters <= part.text.length}
                />
              </label>
              <p className="muted">The original file and the rest of the text remain unchanged.</p>
              <Button
                onClick={() => {
                  if (app.unsaved.confirmDiscard('dialog')) setEditing(false);
                }}
              >
                Cancel
              </Button>
            </Form>
          ) : (
            <HighlightedText
              text={
                part.text ||
                'No meaningful text has been generated yet. Multimodal search can use the media itself.'
              }
              query={query}
              selected={Boolean(query)}
            />
          )}
          {part.totalCharacters > windowSize && (
            <div className="actions document-text-pager">
              <Button
                disabled={part.offset === 0 || editing}
                onClick={() => navigate(page, Math.max(0, part.offset - windowSize))}
              >
                ← Previous text window
              </Button>
              <Button
                disabled={part.nextOffset >= part.totalCharacters || editing}
                onClick={() => navigate(page, part.nextOffset)}
              >
                Next text window →
              </Button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
export function DocumentView({ id, after }: { id: string; after: () => void }) {
  const app = useApplication(),
    modal = useModal();
  const [version, setVersion] = useState(''),
    [page, setPage] = useState(1),
    [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(false),
    [acknowledged, setAcknowledged] = useState(false);
  const [findOpen, setFindOpen] = useState(false),
    [highlight, setHighlight] = useState('');
  const load = useLoad(
    (signal) => api('documents.read', { id, ...(version ? { version } : {}) }, { signal }),
    [id, version],
  );
  usePolling(
    load.reload,
    3000,
    Boolean(load.data?.processing && !terminal.has(load.data.processing.status)),
  );
  useEffect(() => setAcknowledged(false), [load.data?.document.revision]);
  useEffect(() => {
    const find = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    document.addEventListener('keydown', find);
    return () => document.removeEventListener('keydown', find);
  }, []);
  if (!load.data) return <Loading error={load.error} retry={load.reload} />;
  const data = load.data,
    v = data.version;
  const canEdit = canEditDocument(data.document, app.session.user, app.bases.items);
  const currentPage = data.pages.some((part) => part.number === page)
    ? page
    : (data.pages[0]?.number ?? 1);
  const review = data.pages.filter((part) => part.warnings.length || part.method === 'ocr');
  const navigate = (number: number, at = 0) => {
    if (!app.unsaved.confirmDiscard('dialog')) return;
    setPage(number);
    setOffset(at);
    setEditing(false);
  };
  const processing = data.processing;
  return (
    <div className="document-view">
      <p className="eyebrow">MATERIAL · {quantity(data.versions.length, 'version', 'versions')}</p>
      <h2>{data.document.name}</h2>
      {load.error && <Loading error={load.error} retry={load.reload} />}
      <div className="document-version-bar">
        <label>
          Material version
          <select
            value={v.id}
            disabled={editing}
            onChange={(event) => {
              setVersion(event.target.value);
              navigate(1);
              setAcknowledged(false);
              setHighlight('');
            }}
          >
            {data.versions.map((item) => (
              <option key={item.id} value={item.id}>
                {date(item.created)} · {versionStates[item.state]}
                {item.id === data.document.activeVersion ? ' · used for search' : ''}
              </option>
            ))}
          </select>
        </label>
        <a
          className="button-link"
          href={tenantUrl(`/api/documents/${id}?version=${v.id}`)}
          target="_blank"
          rel="noopener"
        >
          Open original ↗
        </a>
        <a
          className="button-link"
          href={tenantUrl(`/api/documents/${id}?version=${v.id}&download=1`)}
        >
          Download original
        </a>
        {data.versions.length > 1 && (
          <Button disabled={editing} onClick={() => modal(<Compare data={data} />)}>
            Compare versions
          </Button>
        )}
        {canEdit && (
          <Button
            disabled={editing}
            onClick={() => modal(<ReplaceDocument doc={data.document} after={after} />)}
          >
            New version
          </Button>
        )}
      </div>
      {processing && !terminal.has(processing.status) && (
        <p className="info-callout" role="status">
          {processing.message || statuses[processing.status]}. Status refreshes automatically.
        </p>
      )}
      {processing?.error && (
        <div className="inline-error" role="alert">
          <strong>Processing incomplete</strong>
          <p>{processing.message || processing.error}</p>
          <small>
            Code: {processing.error} · ID: {processing.diagnostic}
          </small>
          {canEdit && (
            <Button
              onClick={async () => {
                const job = await api('jobs.retry', { id: processing.id });
                app.jobs.upsert(job);
                app.jobs.watch(job);
                load.reload();
                after();
              }}
            >
              Retry processing
            </Button>
          )}
        </div>
      )}
      {data.pages.length > 0 ? (
        <>
          <div className="document-page-bar">
            <label>
              Page / segment
              <select
                aria-label={'Material page'}
                value={currentPage}
                disabled={editing}
                onChange={(event) => navigate(Number(event.target.value))}
              >
                {data.pages.map((part) => (
                  <option key={part.number} value={part.number}>
                    {part.number} of {data.pages.length}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={editing}
              onClick={() => {
                setFindOpen(!findOpen);
                if (findOpen) setHighlight('');
              }}
            >
              {findOpen ? 'Close text search' : 'Find in this document'}
            </Button>
          </div>
          <DocumentFind
            key={v.id}
            id={id}
            version={v.id}
            open={findOpen}
            select={(match, query) => {
              navigate(match.page, Math.max(0, match.offset - 300));
              setHighlight(query);
            }}
          />
          {review.length > 0 && canEdit && (
            <details className="form-section">
              <summary>Pages &amp; segments to review · {review.length}</summary>
              <div className="review-pages">
                {review.map((part) => (
                  <Button
                    key={part.number}
                    disabled={editing}
                    onClick={() => navigate(part.number)}
                  >
                    {part.number}
                    {!part.characters ? ' · no text' : ''}
                  </Button>
                ))}
              </div>
            </details>
          )}
          <PageText
            key={v.id + ':' + currentPage + ':' + offset}
            data={data}
            page={currentPage}
            offset={offset}
            query={highlight}
            editing={editing}
            setEditing={setEditing}
            navigate={navigate}
            corrected={() => {
              setAcknowledged(false);
              load.reload();
              after();
            }}
          />
          {canEdit && v.state === 'review' && !editing && (
            <Button
              onClick={() => {
                setEditing(true);
                setAcknowledged(false);
              }}
            >
              Correct processing text
            </Button>
          )}
          {canEdit && v.state === 'ready' && (
            <Form
              label={'Create correction version'}
              disabled={data.versions.some((item) => item.state !== 'ready')}
              submit={async () => {
                const job = await api('documents.revise', {
                  id,
                  revision: data.document.revision,
                  version: v.id,
                });
                app.jobs.upsert(job);
                app.jobs.watch(job);
                setVersion('');
                navigate(1);
                setAcknowledged(false);
                load.reload();
                after();
                app.notify(
                  'Creating a correction version. The published material remains searchable.',
                );
              }}
            >
              <p>
                Found an error in text, a description, or a transcript? Create a separate version
                and correct the processing result. The original and media segments are preserved
                without rerunning recognition. Search switches after review and publication.
              </p>
              {data.versions.some((item) => item.state !== 'ready') && (
                <p className="muted">
                  A version is already processing or awaiting review. Select it from the version
                  list and finish the review.
                </p>
              )}
            </Form>
          )}
        </>
      ) : (
        <p className="empty-inline">Text and previews appear after processing.</p>
      )}
      {canEdit && data.pages.length > 0 && (
        <section className="document-publication">
          <h3>{v.state === 'ready' ? 'Search this version' : 'Review & publish'}</h3>
          {v.state === 'review' && (
            <>
              <p>
                Compare the text with the original. Correct OCR, descriptions, and transcripts
                above. If the file itself is incorrect, upload a new version.
              </p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={editing}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                I checked the processing result against the original
              </label>
            </>
          )}
          <Button
            className="primary"
            disabled={editing || v.state === 'pending' || (v.state === 'review' && !acknowledged)}
            onClick={async () => {
              const job = await api('documents.publish', {
                id,
                revision: data.document.revision,
                version: v.id,
                acknowledge: true,
                activate: true,
              });
              app.jobs.upsert(job);
              app.jobs.watch(job);
              modal(null);
              after();
              app.notify('Publication and indexing queued.');
            }}
          >
            {v.state === 'ready'
              ? v.id === data.document.activeVersion
                ? 'Reindex'
                : 'Use this version for search'
              : 'Publish & include in search'}
          </Button>
        </section>
      )}
    </div>
  );
}
