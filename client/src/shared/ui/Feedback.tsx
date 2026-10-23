import type { ReactNode } from 'react';
export function Loading({ error = '', retry }: { error?: string; retry?: () => void }) {
  return (
    <div className={error ? 'inline-error' : 'loading'} role={error ? 'alert' : 'status'}>
      {!error && <span className="spinner" aria-hidden="true" />}
      {error || 'Loading…'}
      {error && retry && <button onClick={retry}>Retry</button>}
    </div>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-mark" aria-hidden="true">
        ◇
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
}) {
  return <span className={'badge badge-' + tone}>{children}</span>;
}
export function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className="metric-card">
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}
