import { observer } from 'mobx-react-lite';
import { api } from '../../shared/api/client';
import type { ConversationDetails } from '../../shared/api/contracts.generated';
import { terminal } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { text } from '../../shared/lib/form-data';
import { useModal } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Field, Form } from '../../shared/ui/Form';
import { Markdown } from '../../shared/ui/Markdown';
import { mediaTime } from '../documents/MediaPreview';
import { Source } from '../documents/SourceDialog';
import { statuses } from '../jobs/job-status';
import { ConversationVersions } from './ConversationVersions';
import { Feedback } from '../quality/FeedbackDialog';
export const TurnView = observer(function TurnView({
  turn: t,
}: {
  turn: ConversationDetails['turns'][number];
}) {
  const app = useApplication();

  const modal = useModal(),
    job = app.jobs.items.find((j) => j.id === t.job);
  const versions = app.chat.variantCounts[t.parent] ?? 1;
  const raw = t.answer.trimStart(),
    answer = ['<NO_INFO>', '<CLARIFY>'].some((marker) => marker.startsWith(raw))
      ? ''
      : raw.replace(/^<(?:NO_INFO|CLARIFY)>/u, '');
  return (
    <article className="turn">
      <div className="question">{t.question}</div>
      <span className={'status ' + t.status} role="status">
        {t.redacted ? 'Access to sources revoked' : statuses[t.status]}
      </span>
      {job?.error && !t.redacted && (
        <p className="error">
          {typeof job.result.message === 'string' ? job.result.message : 'Technical error'} ·{' '}
          {job.error} · {job.diagnostic}
        </p>
      )}
      <Markdown
        text={answer || (terminal.has(t.status) ? 'Answer incomplete.' : 'Job in progress…')}
        sources={t.sources}
        onSource={(s) => modal(<Source source={s} />)}
      />
      {!!t.sources.length && (
        <div className="sources">
          <strong>Sources</strong>
          {t.sources.map((s) => (
            <Button key={s.chunk} onClick={() => modal(<Source source={s} />)}>
              [{s.id}] {s.name} · {s.section} ·{' '}
              {s.media?.startMs === undefined ? `p. ${s.page}` : mediaTime(s.media.startMs)}
            </Button>
          ))}
        </div>
      )}
      <div className="actions">
        <Button
          disabled={!answer.trim() || t.redacted}
          onClick={async () => {
            if (!navigator.clipboard)
              throw new Error(
                'Copying requires HTTPS or localhost. Select the answer text to copy it manually.',
              );
            await navigator.clipboard.writeText(answer);
            app.notify('Answer copied.');
          }}
        >
          Copy
        </Button>
        <Button
          onClick={() =>
            modal(
              <>
                <h2>New question version</h2>
                <p>
                  The previous result stays saved. New messages will continue the selected version.
                </p>
                <Form
                  label={'Create version'}
                  submit={async (f) => {
                    await app.chat.send(text(f, 'question'), t.id);
                    modal(null);
                  }}
                >
                  <Field
                    label={'Question'}
                    name="question"
                    type="textarea"
                    value={t.question}
                    required
                  />
                </Form>
              </>,
            )
          }
        >
          Edit question
        </Button>
        <Button onClick={() => app.chat.send(t.question, t.id)} disabled={app.chat.busy}>
          Retry
        </Button>
        <Button onClick={() => modal(<Feedback turn={t} />)}>Rate / report issue</Button>
        {!terminal.has(t.status) && (
          <Button
            onClick={async () => {
              await api('jobs.cancel', { id: t.job });
              await app.chat.refreshChat();
            }}
          >
            Cancel
          </Button>
        )}
        {versions > 1 && (
          <Button
            onClick={() =>
              modal(
                <ConversationVersions
                  conversation={t.conversation}
                  parent={t.parent}
                  selected={t.id}
                />,
              )
            }
          >
            Question versions · {versions}
          </Button>
        )}
      </div>
    </article>
  );
});
