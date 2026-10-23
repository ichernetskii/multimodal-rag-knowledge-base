import { api, uploadFile } from '../../shared/api/client';
import type { DocumentRecord } from '../../shared/api/contracts.generated';
import { useApplication } from '../../shared/lib/application-context';
import { useLoad, useModal } from '../../shared/lib/hooks';
import { Form } from '../../shared/ui/Form';

export function ReplaceDocument({ doc, after }: { doc: DocumentRecord; after: () => void }) {
  const app = useApplication();

  const modal = useModal();
  const limits = useLoad((signal) => api('documents.limits', {}, { signal }));
  return (
    <>
      <h2>New version {doc.name}</h2>
      <Form
        label={'Upload'}
        submit={async (f) => {
          const file = f.get('file');
          if (!(file instanceof File) || !file.size) throw new Error('Choose a file.');
          const limits = await api('documents.limits');
          if (file.size > limits.maxBytes) throw new Error('File size limit exceeded.');
          const r = await uploadFile(file, {
            document: doc.id,
            revision: doc.revision,
            collection: doc.collection,
            conversation: doc.conversation,
          });
          if (r.job) {
            app.jobs.upsert(r.job);
            app.jobs.watch(r.job);
          }
          modal(null);
          after();
          app.notify('The previous version stays available until the new one is published.');
        }}
      >
        <label>
          File
          <input
            type="file"
            name="file"
            required
            accept={limits.data?.supported.map((extension) => '.' + extension).join(',')}
          />
        </label>
      </Form>
    </>
  );
}
