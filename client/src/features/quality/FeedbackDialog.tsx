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
      <h2>Обратная связь</h2>
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
          app.notify('Оценка сохранена для проверки.');
        }}
      >
        <Select
          label="Оценка"
          name="rating"
          value="-1"
          options={[
            ['1', 'Полезно'],
            ['-1', 'Проблема'],
          ]}
        />
        <Select
          label="Причина"
          name="reason"
          options={[
            ['wrong_source', 'Неверный источник'],
            ['outdated', 'Устаревшая информация'],
            ['no_answer', 'Нет ответа'],
            ['irrelevant_answer', 'Ответ не относится к вопросу'],
            ['other', 'Другая причина'],
          ]}
        />
        <Field label="Комментарий" name="detail" type="textarea" />
      </Form>
    </>
  );
}
