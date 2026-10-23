import type { ReactNode } from 'react';
export function Table({
  head,
  rows,
  rowKeys,
  empty = 'No records yet.',
}: {
  head: string[];
  rows: ReactNode[][];
  rowKeys?: string[];
  empty?: string;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row, i) => (
              <tr key={rowKeys?.[i] ?? i}>
                {row.map((cell, j) => (
                  <td key={j} data-label={head[j]}>
                    {typeof cell === 'boolean' ? String(cell) : cell}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={head.length}>
                <div className="table-empty">{empty}</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
export function Pagination({
  page,
  pageSize,
  total,
  onChange,
  loading = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  loading?: boolean;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="pagination" aria-label={'List pages'}>
      <span>
        {total
          ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`
          : '0 records'}
      </span>
      <div>
        <button
          type="button"
          disabled={loading || page <= 1}
          onClick={() => onChange(page - 1)}
          aria-label={'Previous page'}
        >
          ←
        </button>
        <span>
          Page {page} of {pages}
        </span>
        <button
          type="button"
          disabled={loading || page >= pages}
          onClick={() => onChange(page + 1)}
          aria-label={'Next page'}
        >
          →
        </button>
      </div>
    </nav>
  );
}
