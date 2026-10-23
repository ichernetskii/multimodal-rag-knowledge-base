import { useState } from 'react';
import { api } from '../../shared/api/client';
import { useApplication } from '../../shared/lib/application-context';
import { text } from '../../shared/lib/form-data';
import { useLoad } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Field, Form } from '../../shared/ui/Form';
import { Loading } from '../../shared/ui/Feedback';
import { Upload } from '../documents/UploadDialog';

export function Welcome({ finished }: { finished: () => void }) {
  const app = useApplication();

  const load = useLoad(() => api('diagnostics')),
    [collection, setCollection] = useState('');
  return (
    <>
      <h2>First run · 2 / 3</h2>
      <p>Check models &amp; hardware</p>
      {load.data ? (
        <>
          <p>
            {load.data.hardware.cores} cores ·{' '}
            {Math.round(load.data.hardware.totalMemory / 1024 ** 3)} GiB RAM ·{' '}
            {Math.round(load.data.freeBytes / 1024 ** 3)} GiB free
          </p>
          <p
            className={
              load.data.dependencies.embedding && load.data.dependencies.generation
                ? 'muted'
                : 'warning'
            }
          >
            Search: {load.data.dependencies.embedding ? 'ready' : 'unavailable'}; generation:{' '}
            {load.data.dependencies.generation ? 'ready' : 'unavailable'}
          </p>
        </>
      ) : (
        <Loading error={load.error} />
      )}
      {collection ? (
        <Upload
          collection={collection}
          after={() => {
            app.notify('Step 3 / 3: wait for indexing, then ask a test question.');
            finished();
          }}
        />
      ) : (
        <Form
          label={'Create first knowledge base'}
          submit={async (f) => {
            const c = await api('collections.save', {
              name: text(f, 'name'),
              grants: [],
            });
            await app.bases.refresh();
            setCollection(c.id);
          }}
        >
          <Field label={'First knowledge base'} name="name" value={'Documents'} required />
        </Form>
      )}
      <Button onClick={finished}>Open library</Button>
    </>
  );
}
