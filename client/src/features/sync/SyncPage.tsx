import { api } from '../../shared/api/client';
import { useLoad } from '../../shared/lib/hooks';
import { text } from '../../shared/lib/form-data';
import { Form, Field } from '../../shared/ui/Form';
import { PageHeader, Loading } from '../../shared/ui/Feedback';
import { Button } from '../../shared/ui/Button';
import { useApplication } from '../../shared/lib/application-context';
import { observer } from 'mobx-react-lite';
export const Sync = observer(function Sync() {
  const app = useApplication(),
    load = useLoad((signal) => api('sync.list', {}, { signal }));
  const bases = app.bases.items.filter((base) => app.bases.canEdit(base));
  return (
    <>
      <PageHeader
        title={'Folder sync'}
        description={
          'The CLI reads a folder on the client computer and uploads changes through the API. The server cannot access the client disk.'
        }
      />
      <section className="panel">
        <Form
          label={'Create connection'}
          disabled={!bases.length}
          submit={async (f) => {
            await api('sync.save', {
              path: text(f, 'path'),
              collection: text(f, 'collection'),
              policy: text(f, 'policy') as 'keep' | 'exclude' | 'delete',
              intervalMinutes: Number(f.get('intervalMinutes')),
            });
            load.reload();
          }}
        >
          <Field label={'Folder name / path on the client computer'} name="path" required />
          <label>
            Knowledge base
            <select name="collection" required>
              {bases.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            When a local file is deleted
            <select name="policy">
              <option value="keep">Keep in the knowledge base</option>
              <option value="exclude">Exclude from search</option>
              <option value="delete">Delete from the knowledge base</option>
            </select>
          </label>
          <Field
            label={'Check interval, minutes'}
            name="intervalMinutes"
            type="number"
            value={5}
            min={1}
          />
        </Form>
      </section>
      {load.error && <Loading error={load.error} retry={load.reload} />}
      <section className="panel">
        {load.data?.map((c) => (
          <article key={c.id}>
            <h2>{c.path}</h2>
            <p>
              Next client check: {new Date(c.nextRun).toLocaleString()} · Files:{' '}
              {Object.keys(c.mapping).length}
            </p>
            <p>Run this on the computer with the folder:</p>
            <pre>
              <code>yarn cli sync {c.id} /path/to/folder --watch</code>
            </pre>
            <Button
              onClick={async () => {
                await api('sync.delete', { id: c.id, revision: c.revision });
                load.reload();
              }}
            >
              Disconnect sync
            </Button>
          </article>
        ))}
      </section>
    </>
  );
});
