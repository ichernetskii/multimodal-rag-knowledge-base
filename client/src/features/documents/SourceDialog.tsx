import { api } from '../../shared/api/client';
import type { Source as SourceData } from '../../shared/api/contracts.generated';
import { date } from '../../shared/lib/format';
import { useLoad } from '../../shared/lib/hooks';
import { Badge, Loading } from '../../shared/ui/Feedback';
export function Source({ source }: { source: SourceData }) {
  const load = useLoad(
    (signal) => api('sources.read', { chunk: source.chunk }, { signal }),
    [source.chunk],
  );
  if (!load.data) return <Loading error={load.error} retry={load.reload} />;
  const d = load.data,
    s = d.source,
    p = d.page,
    text = p.text.includes(s.text)
      ? p.text
      : (p.sections.find((section) => section.title === s.section)?.text ?? p.text),
    at = text.indexOf(s.text),
    url = `/api/documents/${encodeURIComponent(s.document)}?version=${encodeURIComponent(s.version)}`;
  return (
    <>
      <p className="eyebrow">ИСТОЧНИК ОТВЕТА</p>
      <h2>{s.name}</h2>
      <div className="source-meta">
        <Badge>Страница {s.page}</Badge>
        <span>{s.section}</span>
        <span>Версия от {date(d.version.created)}</span>
      </div>
      <h3>Использованный фрагмент</h3>
      <div className="source-text">
        {at >= 0 ? (
          <>
            {text.slice(Math.max(0, at - 1200), at)}
            <mark>{s.text}</mark>
            {text.slice(at + s.text.length, at + s.text.length + 1200)}
          </>
        ) : (
          <>
            <mark>{s.text}</mark>
            {'\n\n' + text.slice(0, 2400)}
          </>
        )}
      </div>
      <div className="actions source-links">
        <a className="button-link" href={url + '&download=1'}>
          Скачать оригинал
        </a>
        <a className="button-link" href={url + '#page=' + s.page} target="_blank" rel="noopener">
          Открыть страницу оригинала ↗
        </a>
      </div>
      {d.version.name.toLowerCase().endsWith('.pdf') && (
        <iframe
          className="source-preview"
          title={'PDF: ' + s.name + ', страница ' + s.page}
          src={url + '#page=' + s.page}
        />
      )}
    </>
  );
}
