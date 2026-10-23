import { useEffect, useRef, useState } from 'react';
import { api } from '../../shared/api/client';
import type { DocumentMatch } from '../../shared/api/contracts.generated';
import { useLoad } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { Loading } from '../../shared/ui/Feedback';
import { Pagination } from '../../shared/ui/DataTable';
export function HighlightedText({
  text,
  query,
  selected = false,
}: {
  text: string;
  query: string;
  selected?: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) element.current?.querySelector('mark')?.scrollIntoView({ block: 'center' });
  }, [text, query, selected]);
  if (!query.trim())
    return (
      <div ref={element} className="document-reader-text">
        {text}
      </div>
    );
  const expression = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu');
  const pieces = [],
    matches = text.matchAll(expression);
  let previous = 0;
  for (const match of matches) {
    pieces.push(text.slice(previous, match.index));
    pieces.push(<mark key={match.index}>{match[0]}</mark>);
    previous = match.index + match[0].length;
    if (pieces.length >= 4000) break;
  }
  pieces.push(text.slice(previous));
  return (
    <div ref={element} className="document-reader-text">
      {pieces}
    </div>
  );
}
export function DocumentFind({
  id,
  version,
  open,
  select,
}: {
  id: string;
  version: string;
  open: boolean;
  select: (match: DocumentMatch, query: string) => void;
}) {
  const [query, setQuery] = useState(''),
    [submitted, setSubmitted] = useState(''),
    [page, setPage] = useState(1);
  const input = useRef<HTMLInputElement>(null);
  const results = useLoad(
    (signal) =>
      submitted
        ? api('documents.find', { id, version, query: submitted, page, pageSize: 10 }, { signal })
        : Promise.resolve(null),
    [id, version, submitted, page],
  );
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <section className="document-find" aria-label={'Find in material'}>
      <p className="muted">
        Finds an exact word, phrase, or code in this version's text, like Ctrl+F. No AI model is
        called.
      </p>
      <form
        className="document-find-form"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setSubmitted(query.trim());
          if (submitted === query.trim()) results.reload();
        }}
      >
        <label>
          Find text in material
          <input
            type="search"
            ref={input}
            value={query}
            maxLength={200}
            required
            onChange={(event) => setQuery(event.target.value)}
            placeholder={'Word, phrase, or code'}
          />
        </label>
        <button type="submit" disabled={!query.trim() || results.loading}>
          Find
        </button>
      </form>
      {submitted && (
        <div aria-live="polite" aria-busy={results.loading}>
          {results.error ? (
            <Loading error={results.error} retry={results.reload} />
          ) : results.loading ? (
            <Loading />
          ) : (
            results.data && (
              <>
                <p>
                  {results.data.total
                    ? `Matches found: ${results.data.total}${results.data.limited ? ' or more. Refine your query.' : ''}`
                    : 'No matches. Try another word or phrase.'}
                </p>
                {results.data.items.map((match) => (
                  <Button
                    key={match.page + ':' + match.offset}
                    onClick={() => select(match, submitted)}
                  >
                    <strong>Page / segment {match.page}</strong>
                    <span>…{match.snippet}…</span>
                  </Button>
                ))}
                {results.data.total > 10 && (
                  <Pagination
                    page={page}
                    pageSize={10}
                    total={results.data.total}
                    onChange={setPage}
                    loading={results.loading}
                  />
                )}
              </>
            )
          )}
        </div>
      )}
    </section>
  );
}
