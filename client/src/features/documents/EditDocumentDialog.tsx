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
      <h2>Edit document</h2>
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
        <Field label={'Name'} name="name" value={doc.name} />
        <Select
          label={'Status'}
          name="state"
          value={doc.state}
          options={[
            ...(doc.activeVersion ? [['published', 'Published'] as [string, string]] : []),
            ['excluded', 'Excluded'],
            ['archived', 'Archive'],
            ['draft', 'Draft'],
          ]}
        />
      </Form>
      {!doc.activeVersion && (
        <div className="info-callout">
          <p>
            Review the processed version and publish it before it appears in search. Indexing
            automatically changes its status to Published.
          </p>
          <Button
            className="primary"
            onClick={() => modal(<DocumentView id={doc.id} after={after} />)}
          >
            Review &amp; publish
          </Button>
        </div>
      )}
    </>
  );
}
