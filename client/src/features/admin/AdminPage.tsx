import { lazy, Suspense } from 'react';
import { Loading, EmptyState } from '../../shared/ui/Feedback';
import { observer } from 'mobx-react-lite';
import { useApplication } from '../../shared/lib/application-context';
import type { AdminSection } from './admin-sections';
const pages = {
  operations: lazy(() =>
    import('../operations/OperationsPage').then((m) => ({ default: m.Operations })),
  ),
  users: lazy(() => import('../users/UsersPage').then((m) => ({ default: m.Users }))),
  collections: lazy(() =>
    import('../knowledge-bases/AccessPage').then((m) => ({ default: m.Collections })),
  ),
  quality: lazy(() => import('../quality/QualityPage').then((m) => ({ default: m.Quality }))),
  sync: lazy(() => import('../sync/SyncPage').then((m) => ({ default: m.Sync }))),
  backups: lazy(() => import('../backups/BackupsPage').then((m) => ({ default: m.Backups }))),
  settings: lazy(() =>
    import('../settings/SettingsPage').then((m) => ({ default: m.SettingsView })),
  ),
};
export const Admin = observer(function Admin({ section }: { section: AdminSection }) {
  const app = useApplication();
  if (app.session.user?.role !== 'admin')
    return (
      <EmptyState
        title="Нужна роль администратора"
        description="Выберите документы или диалоги в меню рабочего пространства."
      />
    );
  const Page = pages[section];
  return (
    <div id="admin-body" className="page-content">
      <Suspense fallback={<Loading />}>
        <Page key={section} />
      </Suspense>
    </div>
  );
});
