import { lazy, Suspense } from 'react';
import { Loading, EmptyState } from '../../shared/ui/Feedback';
import { observer } from 'mobx-react-lite';
import { useApplication } from '../../shared/lib/application-context';
import { canAccessAdmin, adminSections, type AdminSection } from './admin-sections';
const pages = {
  overview: lazy(() => import('./OverviewPage').then((m) => ({ default: m.Overview }))),
  assistant: lazy(() => import('../settings/SettingsPage').then((m) => ({ default: m.Assistant }))),
  usage: lazy(() => import('./CompanyPages').then((m) => ({ default: m.Usage }))),
  indexes: lazy(() => import('./CompanyPages').then((m) => ({ default: m.Indexes }))),
  audit: lazy(() => import('./CompanyPages').then((m) => ({ default: m.Audit }))),
  tenants: lazy(() => import('./PlatformPages').then((m) => ({ default: m.Tenants }))),
  connections: lazy(() =>
    import('../saas/ConnectionsPage').then((m) => ({ default: m.Connections })),
  ),
  system: lazy(() => import('./PlatformPages').then((m) => ({ default: m.System }))),
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
  if (!canAccessAdmin(section, app.session.user))
    return (
      <EmptyState
        title="Раздел владельца платформы"
        description="Управление компаниями, сервером и подключениями доступно только владельцу платформы. Настройки вашей компании находятся в остальных разделах меню."
      />
    );
  const definition = adminSections[section];
  const company =
    app.session.tenants.find((t) => t.id === app.session.user?.tenant)?.name ?? 'Компания';
  const Page = pages[section];
  return (
    <div id="admin-body" className="page-content">
      <div
        className={'admin-scope ' + (definition.scope === 'platform' ? 'admin-scope-platform' : '')}
      >
        <span>
          {definition.scope === 'platform'
            ? 'Платформа · доступ владельца'
            : 'Компания · ' + company}
        </span>
        <span>
          {definition.scope === 'platform' && section === 'connections'
            ? 'Каталог моделей: ' + company
            : definition.scope === 'company'
              ? 'Изменения относятся только к этой компании'
              : 'Общие настройки установки'}
        </span>
      </div>
      <Suspense fallback={<Loading />}>
        <Page key={section + app.session.user.tenant} />
      </Suspense>
    </div>
  );
});
