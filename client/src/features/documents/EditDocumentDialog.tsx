import { api } from '../../shared/api/client';
import type { DocumentRecord } from '../../shared/api/contracts.generated';
import { text, option } from '../../shared/lib/form-data';
import { useModal } from '../../shared/lib/hooks';
import { Field, Form, Select } from '../../shared/ui/Form';

export function EditDocument({ doc, after }: { doc: DocumentRecord; after: () => void }) {
  const modal = useModal();
  return (
    <>
      <h2>Изменить документ</h2>
      <Form
        submit={async (f) => {
          await api('documents.update', {
            id: doc.id,
            revision: doc.revision,
            name: text(f, 'name'),
            state: option(f, 'state', ['published', 'excluded', 'archived', 'draft'] as const),
          });
          modal(null);
          after();
        }}
      >
        <Field label="Название" name="name" value={doc.name} />
        <Select
          label="Состояние"
          name="state"
          value={doc.state}
          options={[
            ['published', 'Опубликован'],
            ['excluded', 'Исключён'],
            ['archived', 'Архив'],
            ['draft', 'Черновик'],
          ]}
        />
      </Form>
    </>
  );
}
