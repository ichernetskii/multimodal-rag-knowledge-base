import { useState } from 'react';
import { api } from '../../shared/api/client';
import { useDebouncedValue, useLoad } from '../../shared/lib/hooks';
import { Badge, Loading } from '../../shared/ui/Feedback';
import { Pagination } from '../../shared/ui/DataTable';
export function DocumentPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState(''),
    [page, setPage] = useState(1),
    q = useDebouncedValue(query);
  const load = useLoad(
    (signal) =>
      api('documents.list', { query: q, page, pageSize: 10, state: 'published' }, { signal }),
    [q, page],
  );
  return (
    <div className="document-picker">
      <label className="field">
        <span>Ожидаемые документы</span>
        <input
          type="search"
          placeholder="Найти опубликованный документ…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />
      </label>
      <div className="picker-count">
        <Badge>{selected.length} выбрано</Badge>
        {selected.length > 0 && (
          <button type="button" onClick={() => onChange([])}>
            Снять выбор
          </button>
        )}
      </div>
      {load.error && <Loading error={load.error} retry={load.reload} />}
      <div className="picker-list">
        {load.data?.items.map((doc) => (
          <label key={doc.id} className="check">
            <input
              type="checkbox"
              checked={selected.includes(doc.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked ? [...selected, doc.id] : selected.filter((id) => id !== doc.id),
                )
              }
            />
            <span>{doc.name}</span>
          </label>
        ))}
        {load.data && !load.data.items.length && <p className="muted">Документы не найдены.</p>}
      </div>
      {load.data && (
        <Pagination
          page={page}
          pageSize={10}
          total={load.data.total}
          onChange={setPage}
          loading={load.loading}
        />
      )}
    </div>
  );
}
