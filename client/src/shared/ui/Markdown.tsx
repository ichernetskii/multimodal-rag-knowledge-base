import type { ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Source } from '../api/contracts.generated';

export function Markdown({
  text,
  sources = [],
  onSource,
}: {
  text: string;
  sources?: Source[];
  onSource?: (source: Source) => void;
}) {
  const cite = (children: ReactNode): ReactNode =>
    typeof children === 'string'
      ? children.split(/(\[\d+\])/u).map((part, i) => {
          const source = sources.find((s) => part === `[${s.id}]`);
          return source && onSource ? (
            <button
              className="citation"
              key={i}
              onClick={() => onSource(source)}
              aria-label={`Source ${source.id}: ${source.name}, page ${source.page}`}
            >
              {part}
            </button>
          ) : (
            part
          );
        })
      : children;
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) =>
          /^(?:https?:|mailto:|#|\/[^/])/iu.test(url) ? defaultUrlTransform(url) : ''
        }
        components={{
          p: ({ children }) => (
            <p>{Array.isArray(children) ? children.map(cite) : cite(children)}</p>
          ),
          li: ({ children }) => (
            <li>{Array.isArray(children) ? children.map(cite) : cite(children)}</li>
          ),
          td: ({ children }) => (
            <td>{Array.isArray(children) ? children.map(cite) : cite(children)}</td>
          ),
          th: ({ children }) => (
            <th>{Array.isArray(children) ? children.map(cite) : cite(children)}</th>
          ),
          strong: ({ children }) => (
            <strong>{Array.isArray(children) ? children.map(cite) : cite(children)}</strong>
          ),
          em: ({ children }) => (
            <em>{Array.isArray(children) ? children.map(cite) : cite(children)}</em>
          ),
          h1: ({ children }) => (
            <h1>{Array.isArray(children) ? children.map(cite) : cite(children)}</h1>
          ),
          h2: ({ children }) => (
            <h2>{Array.isArray(children) ? children.map(cite) : cite(children)}</h2>
          ),
          h3: ({ children }) => (
            <h3>{Array.isArray(children) ? children.map(cite) : cite(children)}</h3>
          ),
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => <span>{alt}</span>,
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
