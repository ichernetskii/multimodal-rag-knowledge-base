import type { ReactNode } from 'react';
import { useApplication } from '../../shared/lib/application-context';
import { defaultAdminTab, type AdminSection } from './admin-sections';
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
  tab,
}: {
  to: AdminSection;
  children: ReactNode;
  className?: string;
  tab?: string;
}) {
  const app = useApplication();
  return (
    <a
      className={className}
      href={
        '/admin/' + to + ((tab ?? defaultAdminTab(to)) ? '/' + (tab ?? defaultAdminTab(to)) : '')
      }
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        app.navigate('admin', to, tab);
      }}
    >
      {children}
    </a>
  );
}
