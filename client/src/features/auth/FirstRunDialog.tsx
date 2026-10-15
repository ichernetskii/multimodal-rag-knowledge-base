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
      <h2>Первый запуск · 2 / 3</h2>
      <p>Проверка моделей и оборудования</p>
      {load.data ? (
        <>
          <p>
            {load.data.hardware.cores} ядер ·{' '}
            {Math.round(load.data.hardware.totalMemory / 1024 ** 3)} ГиБ RAM ·{' '}
            {Math.round(load.data.freeBytes / 1024 ** 3)} ГиБ свободно
          </p>
          <p
            className={
              load.data.dependencies.embedding && load.data.dependencies.generation
                ? 'muted'
                : 'warning'
            }
          >
            Поиск: {load.data.dependencies.embedding ? 'готов' : 'недоступен'}; генерация:{' '}
            {load.data.dependencies.generation ? 'готова' : 'недоступна'}
          </p>
        </>
      ) : (
        <Loading error={load.error} />
      )}
      {collection ? (
        <Upload
          collection={collection}
          after={() => {
            app.notify('Этап 3 / 3: дождитесь индексации и задайте контрольный вопрос.');
            finished();
          }}
        />
      ) : (
        <Form
          label="Создать первую базу"
          submit={async (f) => {
            const c = await api('collections.save', {
              name: text(f, 'name'),
              grants: [],
            });
            await app.bases.refresh();
            setCollection(c.id);
          }}
        >
          <Field label="Первая база знаний" name="name" value="Документы" required />
        </Form>
      )}
      <Button onClick={finished}>Перейти к библиотеке</Button>
    </>
  );
}
