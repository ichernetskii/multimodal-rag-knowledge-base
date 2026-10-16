import { api } from '../../shared/api/client';
import type { DocumentRecord } from '../../shared/api/contracts.generated';
import { text, option } from '../../shared/lib/form-data';
import { useModal } from '../../shared/lib/hooks';
import { Field, Form, Select } from '../../shared/ui/Form';
import { Button } from '../../shared/ui/Button';
import { DocumentView } from './DocumentDialog';

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
            ...(doc.activeVersion ? [['published', 'Опубликован'] as [string, string]] : []),
            ['excluded', 'Исключён'],
            ['archived', 'Архив'],
            ['draft', 'Черновик'],
          ]}
        />
      </Form>
      {!doc.activeVersion && (
        <div className="info-callout">
          <p>
            Чтобы документ появился в поиске, сначала проверьте обработанную версию и запустите
            публикацию. Индексация автоматически изменит состояние на «Опубликован».
          </p>
          <Button
            className="primary"
            onClick={() => modal(<DocumentView id={doc.id} after={after} />)}
          >
            Проверить и опубликовать
          </Button>
        </div>
      )}
    </>
  );
}
