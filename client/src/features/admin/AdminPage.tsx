import { lazy, Suspense } from 'react';
import { Loading, EmptyState, PageHeader } from '../../shared/ui/Feedback';
import { Tabs } from '../../shared/ui/Tabs';
import { observer } from 'mobx-react-lite';
import { useApplication } from '../../shared/lib/application-context';
import {
  canAccessAdmin,
  canAccessAdminTab,
  adminSections,
  type AdminSection,
} from './admin-sections';
const Models = lazy(() => import('../models/ModelsPage').then((m) => ({ default: m.Models })));
const Usage = lazy(() => import('./CompanyPages').then((m) => ({ default: m.Usage })));
const Audit = lazy(() => import('./CompanyPages').then((m) => ({ default: m.Audit })));
const Tenants = lazy(() => import('./PlatformPages').then((m) => ({ default: m.Tenants })));
const System = lazy(() => import('./PlatformPages').then((m) => ({ default: m.System })));
const Credentials = lazy(() =>
  import('../saas/CredentialsPage').then((m) => ({ default: m.Credentials })),
);
const Operations = lazy(() =>
  import('../operations/OperationsPage').then((m) => ({ default: m.Operations })),
);
const Users = lazy(() => import('../users/UsersPage').then((m) => ({ default: m.Users })));
const Backups = lazy(() => import('../backups/BackupsPage').then((m) => ({ default: m.Backups })));
const Settings = lazy(() =>
  import('../settings/SettingsPage').then((m) => ({ default: m.SettingsView })),
);
export const Admin = observer(function Admin({ section }: { section: AdminSection }) {
  const app = useApplication(),
    user = app.session.user;
  if (!user || !canAccessAdmin(section, user))
    return (
      <EmptyState
        title="Раздел недоступен"
        description={
          adminSections[section].scope === 'platform'
            ? 'Общие API-ключи и состояние системы доступны владельцу платформы.'
            : 'Настройки компании доступны её администратору. Материалы и диалоги находятся в меню компании.'
        }
      />
    );
  const definition = adminSections[section],
    tab = app.navigation.tab;
  if (!canAccessAdminTab(section, tab, user))
    return (
      <EmptyState
        title="Подключения настраивает владелец платформы"
        description="Выбирайте разрешённые модели на вкладке «Назначение моделей»."
      />
    );
  const company = app.session.tenants.find((t) => t.id === user.tenant)?.name ?? 'Компания';
  const tabs = Object.fromEntries(
    Object.entries(definition.tabs).filter(([key]) => canAccessAdminTab(section, key, user)),
  );
  const content =
    section === 'models' ? (
      <Models />
    ) : section === 'users' ? (
      <Users />
    ) : section === 'usage' ? (
      <Usage />
    ) : section === 'credentials' ? (
      <Credentials />
    ) : section === 'system' ? (
      tab === 'companies' ? (
        <Tenants />
      ) : (
        <System />
      )
    ) : tab === 'backups' ? (
      <Backups />
    ) : tab === 'audit' ? (
      <Audit />
    ) : tab === 'processing' ? (
      <Settings />
    ) : (
      <Operations />
    );
  return (
    <div id="admin-body" className="page-content">
      <div
        className={'admin-scope ' + (definition.scope === 'platform' ? 'admin-scope-platform' : '')}
      >
        <span>
          {definition.scope === 'platform'
            ? 'Вся платформа · все компании'
            : 'Компания · ' + company}
        </span>
        <span>
          {definition.scope === 'platform'
            ? 'Общая область управления'
            : 'Изменения относятся только к этой компании'}
        </span>
      </div>
      {section === 'maintenance' && (
        <PageHeader
          title="Обслуживание"
          description="Задания и обслуживание данных выбранной компании."
        />
      )}
      <Suspense fallback={<Loading />}>
        {Object.keys(tabs).length > 1 ? (
          <Tabs
            label={definition.name}
            tabs={tabs}
            selected={tab}
            onChange={(tab) => app.selectTab(tab)}
          >
            <div
              key={
                section +
                ':' +
                tab +
                ':' +
                (definition.scope === 'company' ? user.tenant : 'platform')
              }
            >
              {content}
            </div>
          </Tabs>
        ) : (
          <div key={section + ':' + user.tenant}>{content}</div>
        )}
      </Suspense>
    </div>
  );
});
