import type { ReactNode } from 'react';
import { useApplication } from '../../shared/lib/application-context';
import { Icon } from '../../shared/ui/Icon';
import { adminSections, type AdminSection } from './admin-sections';
export const money = (micros: number) =>
  new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: micros > 0 && micros < 10000 ? 6 : 2,
  }).format(micros / 1e6);
export function AdminLink({
  to,
  children,
  className = '',
}: {
  to: AdminSection;
  children: ReactNode;
  className?: string;
}) {
  const app = useApplication();
  return (
    <a
      className={className}
      href={'/admin/' + to}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        app.navigation.navigate('admin', to);
      }}
    >
      {children}
    </a>
  );
}
export function TaskCard({ to }: { to: AdminSection }) {
  const section = adminSections[to];
  return (
    <AdminLink to={to} className="admin-task-card">
      <span className="admin-task-icon">
        <Icon name={section.icon} />
      </span>
      <span>
        <strong>{section.name}</strong>
        <small>{section.description}</small>
      </span>
      <Icon name="arrow" size={16} />
    </AdminLink>
  );
}
