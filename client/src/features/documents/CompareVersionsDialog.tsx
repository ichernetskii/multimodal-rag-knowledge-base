import { useState } from 'react';
import { api } from '../../shared/api/client';
import type { DocumentDetails } from '../../shared/api/contracts.generated';
import { text } from '../../shared/lib/form-data';
import { date } from '../../shared/lib/format';
import { useLoad } from '../../shared/lib/hooks';
import { Form, Select } from '../../shared/ui/Form';
import { Button } from '../../shared/ui/Button';
import { Badge, Loading } from '../../shared/ui/Feedback';
export function Compare({ data }: { data: DocumentDetails }) {
  const [selection, setSelection] = useState<{ left: string; right: string } | null>(null);
  const [page, setPage] = useState(1),
    [offset, setOffset] = useState(0);
  const load = useLoad(
    (signal) =>
      selection
        ? api(
            'documents.compare',
            {
              id: data.document.id,
              ...selection,
              page,
              offset,
              limit: 12000,
            },
            { signal },
          )
        : Promise.resolve(null),
    [selection, page, offset],
  );
  const options: [string, string][] = data.versions.map((version, index) => [
    version.id,
    `Версия ${data.versions.length - index} · ${date(version.created)}`,
  ]);
  const comparison = load.data;
  const total = Math.max(
    comparison?.left?.totalCharacters ?? 0,
    comparison?.right?.totalCharacters ?? 0,
  );
  return (
    <div className="document-comparison">
      <h2>Сравнение текста двух версий</h2>
      <p className="muted">
        Выберите версии. Большие страницы загружаются фрагментами; оригиналы остаются без изменений.
      </p>
      <Form
        label="Сравнить"
        submit={async (form) => {
          setPage(1);
          setOffset(0);
          setSelection({ left: text(form, 'left'), right: text(form, 'right') });
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
      {selection &&
        (load.error ? (
          <Loading error={load.error} retry={load.reload} />
        ) : load.loading ? (
          <Loading />
        ) : (
          comparison && (
            <>
              <div className="document-page-bar">
                <label>
                  Страница / сегмент
                  <select
                    value={page}
                    onChange={(event) => {
                      setPage(Number(event.target.value));
                      setOffset(0);
                    }}
                  >
                    {comparison.pages.map((number) => (
                      <option key={number} value={number}>
                        {number}
                      </option>
                    ))}
                  </select>
                </label>
                <Badge
                  tone={comparison.left?.text === comparison.right?.text ? 'success' : 'warning'}
                >
                  {comparison.left?.text === comparison.right?.text
                    ? 'Текст фрагмента совпадает'
                    : 'Текст фрагмента отличается'}
                </Badge>
              </div>
              <div className="split">
                {(['left', 'right'] as const).map((side) => (
                  <section key={side}>
                    <h3>{side === 'left' ? 'Старая версия' : 'Новая версия'}</h3>
                    <pre>{comparison[side]?.text ?? 'Страницы нет в этой версии.'}</pre>
                  </section>
                ))}
              </div>
              {total > 12000 && (
                <div className="actions">
                  <Button
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - 12000))}
                  >
                    ← Предыдущий фрагмент
                  </Button>
                  <span>
                    {offset + 1}–{Math.min(total, offset + 12000)} из {total}
                  </span>
                  <Button
                    disabled={offset + 12000 >= total}
                    onClick={() => setOffset(offset + 12000)}
                  >
                    Следующий фрагмент →
                  </Button>
                </div>
              )}
            </>
          )
        ))}
    </div>
  );
}
