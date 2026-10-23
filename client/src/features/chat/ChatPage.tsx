import { tenantUrl } from '../../shared/api/client';
import { runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../shared/api/client';
import { useApplication } from '../../shared/lib/application-context';
import { text } from '../../shared/lib/form-data';
import { useModal, useLoad } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Field, Form } from '../../shared/ui/Form';
import { Loading } from '../../shared/ui/Feedback';
import { Upload } from '../documents/UploadDialog';
import { KnowledgeBaseSelector } from '../knowledge-bases/KnowledgeBaseSelector';
import { TurnView } from './Turn';
import { Attachments } from './Attachments';
export const Chat = observer(function Chat({ sidebar }: { sidebar: () => void }) {
  const app = useApplication();

  const modal = useModal(),
    messages = useRef<HTMLDivElement>(null),
    [follow, setFollow] = useState(true);
  const previousHeight = useRef<number | undefined>(undefined);
  const id = app.chat.conversation?.id,
    branch = app.chat.branch;
  const last = branch.at(-1),
    streamContent = `${last?.id}:${last?.answer.length}:${last?.status}`,
    visible = branch;
  useEffect(() => {
    setFollow(true);
  }, [id]);
  useLayoutEffect(() => {
    if (previousHeight.current !== undefined && messages.current) {
      messages.current.scrollTop += messages.current.scrollHeight - previousHeight.current;
      previousHeight.current = undefined;
    }
  }, [branch.length]);
  useEffect(() => {
    if (follow && messages.current) messages.current.scrollTop = messages.current.scrollHeight;
  }, [streamContent, follow]);
  const profiles = useLoad((signal) => api('models.list', {}, { signal }));
  const c = app.chat.conversation;
  if (app.chat.loadingChat) return <Loading />;
  if (!c)
    return (
      <div className="empty">
        <h1>Start a conversation</h1>
        <Button className="primary" onClick={() => app.chat.newChat()}>
          + New conversation
        </Button>
      </div>
    );
  return (
    <>
      {app.jobs.disconnected.some(
        (id) => app.jobs.items.find((j) => j.id === id)?.kind === 'answer',
      ) && (
        <div className="reconnect-banner" role="status">
          Connection interrupted. Reconnecting to the saved job…
        </div>
      )}
      <div className="toolbar chat-toolbar">
        <Button onClick={sidebar}>☰ Conversations</Button>
        <h1 title={c.title}>{c.title}</h1>
        <label>
          Model
          <select
            aria-label={'Answer model'}
            value={app.chat.profile}
            onChange={(e) =>
              runInAction(() => {
                app.chat.profile = e.target.value;
              })
            }
          >
            <option value="">Company default</option>
            {profiles.data
              ?.filter((p) => p.role === 'generation' && p.enabled)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        <Button
          onClick={() =>
            modal(
              <>
                <h2>Conversation title</h2>
                <Form
                  submit={async (f) => {
                    await app.chat.saveConversation({ title: text(f, 'title') });
                    modal(null);
                  }}
                >
                  <Field label={'Name'} name="title" value={c.title} />
                </Form>
              </>,
            )
          }
        >
          Rename
        </Button>
        <a className="button-link" href={tenantUrl(`/api/conversations/${c.id}/export`)}>
          Export
        </a>
        <Button
          onClick={() =>
            modal(
              <>
                <h2>Delete this conversation and its attachments?</h2>
                <Button
                  className="danger"
                  onClick={async () => {
                    await app.chat.flushDraft();
                    await api('conversations.delete', {
                      id: c.id,
                      revision: app.chat.conversation!.revision,
                    });
                    localStorage.removeItem('rag-draft-' + c.id);
                    app.chat.reset();
                    await app.chat.newChat();
                    modal(null);
                  }}
                >
                  Delete permanently
                </Button>
              </>,
            )
          }
        >
          Delete
        </Button>
      </div>
      <KnowledgeBaseSelector
        value={app.chat.scope.collection ?? ''}
        onChange={(id) =>
          runInAction(() => {
            app.chat.scope = { collection: id };
          })
        }
      />
      <div
        id="messages"
        className="messages"
        role="log"
        aria-label={'Messages'}
        ref={messages}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
      >
        {app.chat.historyBefore && (
          <Button
            className="load-older"
            disabled={app.chat.loadingOlder}
            onClick={async () => {
              previousHeight.current = messages.current?.scrollHeight;
              setFollow(false);
              await app.chat.loadOlder();
            }}
          >
            Load earlier messages
          </Button>
        )}
        {branch.length ? (
          visible.map((t) => <TurnView key={t.id} turn={t} />)
        ) : (
          <div className="empty">
            <h2>Start with a specific question</h2>
            <p>Choose a knowledge base and ask about your documents.</p>
          </div>
        )}
      </div>
      {!follow && (
        <Button className="latest" onClick={() => setFollow(true)}>
          ↓ Latest message
        </Button>
      )}
      <Attachments key={c.id} conversation={c.id} />
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          setFollow(true);
          void app.execute(() => app.chat.send());
        }}
      >
        <textarea
          id="question"
          name="question"
          maxLength={5000}
          aria-label={'Message'}
          placeholder={'Ask about your documents…'}
          value={app.chat.draft}
          onChange={(e) => app.chat.setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="actions">
          <button id="send" className="primary" disabled={app.chat.busy || !app.chat.draft.trim()}>
            {app.chat.busy ? 'Sending…' : 'Send'}
          </button>
          <Button onClick={() => modal(<Upload conversation={c.id} />)}>Attach file</Button>
          <small>Ctrl/⌘ + Enter · attachments are private to you</small>
        </div>
      </form>
    </>
  );
});
