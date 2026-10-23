import { Component, lazy, Suspense, useEffect, useState, useRef, type ReactNode } from 'react';
import { observer } from 'mobx-react-lite';
import { runInAction } from 'mobx';
import { Admin } from '../features/admin/AdminPage';
import { adminNames, adminSections, roleNames } from '../features/admin/admin-sections';
import { Account } from '../features/auth/AccountDialog';
import { Auth } from '../features/auth/LoginPage';
import { useApplication } from '../shared/lib/application-context';
import { useModal, useMediaQuery } from '../shared/lib/hooks';
import { Button } from '../shared/ui/Button';
import { Loading } from '../shared/ui/Feedback';
import { Icon } from '../shared/ui/Icon';
import { ModalProvider } from '../shared/ui/Modal';
import { ApplicationProvider } from './ApplicationProvider';
import type { ApplicationStore } from './application-store';
import { WorkspaceNavigation } from './navigation/WorkspaceNavigation';
const Chat = lazy(() => import('../features/chat/ChatPage').then((m) => ({ default: m.Chat })));
const Documents = lazy(() =>
  import('../features/knowledge-bases/KnowledgeWorkspace').then((m) => ({
    default: m.KnowledgeWorkspace,
  })),
);
const ConversationSidebar = lazy(() =>
  import('../features/chat/ConversationSidebar').then((m) => ({ default: m.ConversationSidebar })),
);
const Welcome = lazy(() =>
  import('../features/auth/FirstRunDialog').then((m) => ({ default: m.Welcome })),
);
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="empty-state">
        <h1>Could not open the application</h1>
        <p>Refresh the page to load the latest version.</p>
        <button onClick={() => window.location.reload()}>Refresh page</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
const Shell = observer(function Shell() {
  const app = useApplication(),
    modal = useModal(),
    [sidebar, setSidebar] = useState(false);
  const mobile = useMediaQuery('(max-width: 800px)'),
    sidebarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (app.session.phase === 'ready' && sessionStorage.getItem('rag-welcome')) {
      sessionStorage.removeItem('rag-welcome');
      modal(
        <Suspense fallback={<Loading />}>
          <Welcome finished={() => modal(null)} />
        </Suspense>,
      );
    }
  }, [app.session.phase]);
  useEffect(() => {
    if (app.session.phase !== 'ready') modal(null);
  }, [app.session.phase]);
  useEffect(() => {
    setSidebar(false);
  }, [app.view, app.navigation.section]);
  useEffect(() => {
    if (!mobile) setSidebar(false);
  }, [mobile]);
  useEffect(() => {
    if (!sidebar || !mobile) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null,
      element = sidebarRef.current;
    const focusable = () =>
      [
        ...(element?.querySelectorAll<HTMLElement>(
          'a[href],button:not(:disabled),input,select,textarea,[tabindex="0"]',
        ) ?? []),
      ].filter((item) => item.getClientRects().length > 0);
    focusable()[0]?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSidebar(false);
      }
      if (event.key === 'Tab') {
        const controls = focusable(),
          first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    element?.addEventListener('keydown', close);
    return () => {
      element?.removeEventListener('keydown', close);
      previous?.focus();
    };
  }, [sidebar, mobile]);
  useEffect(() => {
    if (app.session.phase !== 'ready') return;
    const refresh = () => {
        if (!document.hidden) void app.session.refresh();
      },
      timer = setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [app.session.phase]);
  useEffect(() => {
    if (app.session.phase !== 'error') return;
    const timer = setInterval(() => {
      if (!document.hidden) void app.boot().catch(() => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, [app.session.phase]);
  if (app.session.phase === 'loading')
    return (
      <main id="main" className="auth">
        <Loading />
      </main>
    );
  if (app.session.phase === 'error')
    return (
      <main id="main" className="auth">
        <h1>Server unavailable</h1>
        <p>Could not connect to the workspace. Retrying automatically.</p>
        <Button onClick={() => app.boot()}>Reconnect</Button>
      </main>
    );
  if (app.session.phase !== 'ready' || !app.session.user) return <Auth />;
  const user = app.session.user,
    title =
      app.view === 'admin'
        ? adminNames[app.navigation.section]
        : app.view === 'documents'
          ? 'Knowledge base'
          : 'Conversations';
  const platform =
    app.view === 'admin' && adminSections[app.navigation.section].scope === 'platform';
  const company = app.session.tenants.find((t) => t.id === user.tenant)?.name ?? 'Company';
  return (
    <div className={'app-shell' + (sidebar ? ' sidebar-open' : '')}>
      {sidebar && (
        <button
          className="sidebar-backdrop"
          aria-label={'Close menu'}
          onClick={() => setSidebar(false)}
        />
      )}
      <aside id="sidebar" className="app-sidebar" ref={sidebarRef} aria-label={'Navigation'}>
        <a
          className="brand"
          href="/chat"
          onClick={(event) => {
            event.preventDefault();
            app.navigate('chat');
          }}
        >
          <span className="brand-symbol">
            <Icon name="documents" size={23} />
          </span>
          <span>
            Multimodal RAG<small>KNOWLEDGE BASE</small>
          </span>
        </a>
        <WorkspaceNavigation />
        {app.view === 'chat' && (
          <div className="sidebar-conversations">
            <Suspense fallback={<Loading />}>
              <ConversationSidebar selected={() => setSidebar(false)} />
            </Suspense>
          </div>
        )}
        <div className="sidebar-footer">
          <div className="local-indicator">
            <span /> {platform ? 'Platform' : company}
          </div>
          <div className="account-row">
            <button className="account-button" onClick={() => modal(<Account />)}>
              <span className="avatar">{user.login.slice(0, 2).toUpperCase()}</span>
              <span>
                <strong>{user.login}</strong>
                <small>{user.operator ? 'Platform owner' : roleNames[user.role]}</small>
              </span>
            </button>
            <Button
              className="icon-button"
              aria-label={'Sign out'}
              title={'Sign out'}
              onClick={() => app.session.logout()}
            >
              <Icon name="logout" size={18} />
            </Button>
          </div>
        </div>
      </aside>
      <div className="workspace" inert={sidebar && mobile}>
        {!app.session.connected && (
          <div className="reconnect-banner" role="status">
            Connection lost. Reconnecting automatically.
          </div>
        )}
        <header className="workspace-header">
          <button
            className="icon-button menu-toggle"
            aria-label={'Open menu'}
            aria-expanded={sidebar}
            aria-controls="sidebar"
            onClick={() => setSidebar(!sidebar)}
          >
            <Icon name="menu" />
          </button>
          <div className="breadcrumb">
            <span>{platform ? 'Platform' : company}</span>
            <Icon name="arrow" size={14} />
            <strong>{title}</strong>
          </div>
          {platform ? (
            <span className="workspace-tag">
              <Icon name="shield" size={14} /> All companies
            </span>
          ) : (
            <label className="tenant-selector header-tenant-selector">
              <span>Company</span>
              <select
                aria-label={'Company'}
                value={user.tenant}
                onChange={(event) => void app.execute(() => app.switchCompany(event.target.value))}
              >
                {app.session.tenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id} disabled={tenant.blocked}>
                    {tenant.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </header>
        <main
          id="main"
          tabIndex={-1}
          className={app.view === 'chat' ? 'chat-main' : 'content-main'}
        >
          <ErrorBoundary key={user.tenant + app.view + app.navigation.section}>
            <Suspense fallback={<Loading />}>
              {app.view === 'chat' ? (
                <Chat sidebar={() => setSidebar(!sidebar)} />
              ) : app.view === 'documents' ? (
                <Documents />
              ) : (
                <Admin section={app.navigation.section} />
              )}
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
});
const Notice = observer(function Notice() {
  const app = useApplication();
  useEffect(() => {
    if (!app.notice) return;
    const timer = setTimeout(
      () =>
        runInAction(() => {
          app.notice = '';
        }),
      8000,
    );
    return () => clearTimeout(timer);
  }, [app.notice]);
  return (
    <div id="notice" role="status" aria-live="polite" className={app.notice ? 'visible' : ''}>
      {app.notice}
      <button aria-label={'Dismiss notification'} onClick={() => app.notify('')}>
        ×
      </button>
    </div>
  );
});
export function App({ application }: { application: ApplicationStore }) {
  useEffect(() => {
    void application.execute(() => application.boot());
    return () => application.dispose();
  }, [application]);
  return (
    <ApplicationProvider application={application}>
      <ModalProvider>
        <ErrorBoundary>
          <Shell />
          <Notice />
        </ErrorBoundary>
      </ModalProvider>
    </ApplicationProvider>
  );
}
