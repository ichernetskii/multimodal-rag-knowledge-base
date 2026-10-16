import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { api } from '../../shared/api/client';
import { useApplication } from '../../shared/lib/application-context';
import { useLoad, useModal } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Loading } from '../../shared/ui/Feedback';
import { DocumentView } from '../documents/DocumentDialog';
export const Attachments = observer(function Attachments({
  conversation,
}: {
  conversation: string;
}) {
  const app = useApplication(),
    modal = useModal();
  const load = useLoad(
    (signal) => api('documents.list', { scope: { conversation }, pageSize: 100 }, { signal }),
    [conversation],
  );
  useEffect(() => {
    const timer = setInterval(load.reload, 5000);
    return () => clearInterval(timer);
  }, [load.reload]);
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
      {load.data.total > 100 && (
        <p>Показаны первые 100 вложений. Остальные доступны в библиотеке документов.</p>
      )}
    </details>
  );
});
