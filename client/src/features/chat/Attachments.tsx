import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { api } from '../../shared/api/client';
import { useApplication } from '../../shared/lib/application-context';
import { useLoad, useModal, usePolling } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Loading } from '../../shared/ui/Feedback';
import { DocumentView } from '../documents/DocumentDialog';
import { Pagination } from '../../shared/ui/DataTable';
export const Attachments = observer(function Attachments({
  conversation,
}: {
  conversation: string;
}) {
  const app = useApplication(),
    modal = useModal(),
    [page, setPage] = useState(1);
  const load = useLoad(
    (signal) => api('documents.list', { scope: { conversation }, page, pageSize: 20 }, { signal }),
    [conversation, page, app.jobs.documentEpoch],
  );
  usePolling(load.reload);
  if (load.error) return <Loading error={load.error} retry={load.reload} />;
  if (!load.data?.items.length) return null;
  return (
    <details className="chat-attachments" open>
      <summary>Вложения диалога · {load.data.total}</summary>
      <p className="muted">
        Проверьте распознанный материал и опубликуйте. Отметьте до трёх вложений как основные
        источники следующего вопроса. В ответ попадёт ограниченное число кадров.
      </p>
      {load.data.items.map((doc) => (
        <div className="actions" key={doc.id}>
          <label>
            <input
              type="checkbox"
              checked={app.chat.attachments.includes(doc.id)}
              disabled={
                doc.state !== 'published' ||
                (!app.chat.attachments.includes(doc.id) && app.chat.attachments.length >= 3)
              }
              onChange={() => app.chat.toggleAttachment(doc.id)}
            />{' '}
            {doc.name}
          </label>
          <Button onClick={() => modal(<DocumentView id={doc.id} after={load.reload} />)}>
            {doc.processing?.reviewRequired
              ? 'Проверить и опубликовать'
              : doc.state === 'published'
                ? 'Просмотреть'
                : 'Обработка / состояние'}
          </Button>
          {doc.processing?.error && <span role="status">{doc.processing.error}</span>}
        </div>
      ))}
      {load.data.total > 20 && (
        <Pagination
          page={page}
          pageSize={20}
          total={load.data.total}
          onChange={setPage}
          loading={load.loading}
        />
      )}
    </details>
  );
});
