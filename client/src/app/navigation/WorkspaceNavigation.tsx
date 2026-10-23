import { observer } from 'mobx-react-lite';
import { useApplication } from '../../shared/lib/application-context';
import { Icon } from '../../shared/ui/Icon';
import { adminGroups, adminSections } from '../../features/admin/admin-sections';

export const WorkspaceNavigation = observer(function WorkspaceNavigation() {
  const app = useApplication(),
    user = app.session.user;
  if (!user) return null;
  const company =
    app.session.tenants.find((tenant) => tenant.id === user.tenant)?.name ?? 'Company';
  return (
    <nav className="workspace-navigation" aria-label={'Workspace'}>
      <div className="workspace-nav nav-company">
        <p className="nav-label">Company · {company}</p>
        {(['chat', 'documents'] as const).map((view) => (
          <button
            key={view}
            aria-current={app.view === view ? 'page' : undefined}
            onClick={() => app.navigate(view)}
          >
            <Icon name={view} />
            <span>{view === 'chat' ? 'Conversations' : 'Knowledge base'}</span>
          </button>
        ))}
        {adminGroups(user)
          .filter((group) => group.scope === 'company')
          .flatMap((group) => group.sections)
          .map((section) => (
            <button
              key={section}
              aria-current={
                app.view === 'admin' && app.navigation.section === section ? 'page' : undefined
              }
              onClick={() => app.navigate('admin', section)}
            >
              <Icon name={adminSections[section].icon} />
              <span>{adminSections[section].name}</span>
            </button>
          ))}
      </div>
      {adminGroups(user)
        .filter((group) => group.scope === 'platform')
        .map((group) => (
          <div className="workspace-nav nav-platform" key={group.scope}>
            <p className="nav-label">{group.name}</p>
            {group.sections.map((section) => (
              <button
                key={section}
                aria-current={
                  app.view === 'admin' && app.navigation.section === section ? 'page' : undefined
                }
                onClick={() => app.navigate('admin', section)}
              >
                <Icon name={adminSections[section].icon} />
                <span>{adminSections[section].name}</span>
              </button>
            ))}
          </div>
        ))}
    </nav>
  );
});
