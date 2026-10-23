import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { useApplication } from '../../shared/lib/application-context';
import { Button } from '../../shared/ui/Button';

export const ConversationSidebar = observer(function ConversationSidebar({
  selected,
}: {
  selected: () => void;
}) {
  const app = useApplication();

  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      void app.execute(() => app.chat.loadConversations(query));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  return (
    <>
      <h2>Conversations</h2>
      <Button
        className="primary"
        onClick={async () => {
          await app.chat.newChat();
          selected();
        }}
      >
        + New conversation
      </Button>
      <label>
        Search conversations
        <input name="conversation-query" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div id="conversation-list" className="conversation-list">
        {app.chat.conversations.map((c) => (
          <button
            key={c.id}
            aria-current={app.chat.conversation?.id === c.id ? 'page' : undefined}
            onClick={() => {
              void app.execute(async () => {
                await app.chat.openChat(c.id);
                selected();
              });
            }}
          >
            {c.title}
          </button>
        ))}
        {app.chat.conversations.length < app.chat.conversationTotal && (
          <Button onClick={() => app.chat.loadConversations(query, app.chat.conversationPage + 1)}>
            Load more
          </Button>
        )}
        {!app.chat.conversations.length && <small>No conversations yet</small>}
      </div>
    </>
  );
});
