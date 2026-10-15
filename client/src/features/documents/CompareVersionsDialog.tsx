import { useState } from 'react';
import { api } from '../../shared/api/client';
import type { DocumentDetails, Page } from '../../shared/api/contracts.generated';
import { text } from '../../shared/lib/form-data';
import { Form, Select } from '../../shared/ui/Form';
import { Badge } from '../../shared/ui/Feedback';

export function Compare({ data }: { data: DocumentDetails }) {
  const [pages, setPages] = useState<{ left: Page[]; right: Page[] }>();
  const [page, setPage] = useState(1);
  const options: [string, string][] = data.versions.map((v, index) => [
    v.id,
    `Версия ${data.versions.length - index} · ${new Date(v.created).toLocaleString()}`,
  ]);
  const numbers = pages
    ? [...new Set([...pages.left, ...pages.right].map((item) => item.number))].sort((a, b) => a - b)
    : [];
  const left = pages?.left.find((item) => item.number === page),
    right = pages?.right.find((item) => item.number === page);
  return (
    <>
      <h2>Сравнение извлечённого текста</h2>
      <p className="muted">
        Выберите две версии. Сравнение показано по страницам, чтобы большие документы было удобно
        просматривать.
      </p>
      <Form
        label="Сравнить"
        submit={async (f) => {
          const result = await api('documents.compare', {
            id: data.document.id,
            left: text(f, 'left'),
            right: text(f, 'right'),
          });
          setPages(result);
          setPage(result.left[0]?.number ?? result.right[0]?.number ?? 1);
        }}
      >
        <div className="form-grid">
          <Select
            label="Старая версия"
            name="left"
            options={options}
            value={data.versions[1]?.id ?? data.version.id}
          />
          <Select label="Новая версия" name="right" options={options} value={data.version.id} />
        </div>
      </Form>
      {pages && (
        <>
          <div className="document-page-bar">
            <label className="field">
              Страница
              <select value={page} onChange={(event) => setPage(Number(event.target.value))}>
                {numbers.map((number) => (
                  <option key={number} value={number}>
                    {number}
                  </option>
                ))}
              </select>
            </label>
            <Badge tone={left?.text === right?.text ? 'success' : 'warning'}>
              {left?.text === right?.text ? 'Текст совпадает' : 'Текст отличается'}
            </Badge>
          </div>
          <div className="split">
            {(['left', 'right'] as const).map((key) => (
              <div key={key}>
                <h3>{key === 'left' ? 'Старая версия' : 'Новая версия'}</h3>
                <pre>{(key === 'left' ? left : right)?.text ?? 'Страницы нет в этой версии.'}</pre>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
