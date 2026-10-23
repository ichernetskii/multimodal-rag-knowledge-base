import { api } from '../../shared/api/client';
import type { Turn } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { text, option } from '../../shared/lib/form-data';
import { useModal } from '../../shared/lib/hooks';
import { Field, Form, Select } from '../../shared/ui/Form';

export function Feedback({ turn }: { turn: Turn }) {
  const app = useApplication();

  const modal = useModal();
  return (
    <>
      <h2>Feedback</h2>
      <Form
        submit={async (f) => {
          await api('feedback.create', {
            turn: turn.id,
            rating: text(f, 'rating') === '1' ? 1 : -1,
            reason: option(f, 'reason', [
              'wrong_source',
              'outdated',
              'no_answer',
              'irrelevant_answer',
              'other',
            ] as const),
            detail: text(f, 'detail'),
          });
          modal(null);
          app.notify('Feedback saved for review.');
        }}
      >
        <Select
          label={'Rating'}
          name="rating"
          value="-1"
          options={[
            ['1', 'Helpful'],
            ['-1', 'Problem'],
          ]}
        />
        <Select
          label={'Reason'}
          name="reason"
          options={[
            ['wrong_source', 'Incorrect source'],
            ['outdated', 'Outdated information'],
            ['no_answer', 'No answer'],
            ['irrelevant_answer', 'Answer does not address the question'],
            ['other', 'Other reason'],
          ]}
        />
        <Field label={'Comment'} name="detail" type="textarea" />
      </Form>
    </>
  );
}
