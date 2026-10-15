import { useState } from 'react';
import { api } from '../../shared/api/client';
import { useApplication } from '../../shared/lib/application-context';
import { date } from '../../shared/lib/format';
import { useLoad, useModal } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Badge, Loading } from '../../shared/ui/Feedback';
import { Table, Pagination } from '../../shared/ui/DataTable';
import { statuses } from '../jobs/job-status';
export function ConversationVersions({
  conversation,
  parent,
  selected,
}: {
  conversation: string;
  parent: string;
  selected: string;
}) {
  const app = useApplication(),
    modal = useModal(),
    [page, setPage] = useState(1),
    load = useLoad(
      (signal) =>
        api('conversations.variants', { id: conversation, parent, page, pageSize: 10 }, { signal }),
      [conversation, parent, page],
    );
  return (
    <>
      <p className="eyebrow">ИСТОРИЯ ВОПРОСА</p>
      <h2>Версии вопроса</h2>
      <p className="muted">
        Выбранный результат станет продолжением диалога. Остальные версии сохранятся.
      </p>
      {load.error && <Loading error={load.error} retry={load.reload} />}{' '}
      {load.data ? (
        <>
          <Table
            head={['Вопрос', 'Создан', 'Состояние', 'Выбор']}
            rowKeys={load.data.items.map((t) => t.id)}
            rows={load.data.items.map((turn) => [
              <strong>{turn.question}</strong>,
              date(turn.created),
              <Badge>{statuses[turn.status]}</Badge>,
              turn.id === selected ? (
                <Badge tone="success">Выбрана</Badge>
              ) : (
                <Button
                  onClick={async () => {
                    await app.chat.saveConversation({ selected: turn.id });
                    modal(null);
                  }}
                >
                  Выбрать
                </Button>
              ),
            ])}
          />
          <Pagination
            page={page}
            pageSize={10}
            total={load.data.total}
            onChange={setPage}
            loading={load.loading}
          />
        </>
      ) : (
        <Loading />
      )}
    </>
  );
}
