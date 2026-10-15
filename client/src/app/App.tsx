import { Component, lazy, Suspense, useEffect, useState, useRef, type ReactNode } from 'react';
import { observer } from 'mobx-react-lite';
import { runInAction } from 'mobx';
import { Admin } from '../features/admin/AdminPage';
import { adminNames, type AdminSection } from '../features/admin/admin-sections';
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
const Chat = lazy(() => import('../features/chat/ChatPage').then((m) => ({ default: m.Chat })));
const Documents = lazy(() =>
  import('../features/documents/DocumentsPage').then((m) => ({ default: m.Documents })),
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
        <h1>Не удалось открыть интерфейс</h1>
        <p>Обновите страницу, чтобы загрузить актуальную сборку.</p>
        <button onClick={() => window.location.reload()}>Обновить страницу</button>
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
        <h1>Сервер недоступен</h1>
        <p>Не удалось подключиться к рабочему пространству. Повторяем попытки автоматически.</p>
        <Button onClick={() => app.boot()}>Повторить подключение</Button>
      </main>
    );
  if (app.session.phase !== 'ready' || !app.session.user) return <Auth />;
  const user = app.session.user,
    title =
      app.view === 'admin'
        ? adminNames[app.navigation.section]
        : app.view === 'documents'
          ? 'Библиотека документов'
          : 'Диалоги';
  return (
    <div className={'app-shell' + (sidebar ? ' sidebar-open' : '')}>
      {sidebar && (
        <button
          className="sidebar-backdrop"
          aria-label="Закрыть меню"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside id="sidebar" className="app-sidebar" ref={sidebarRef} aria-label="Навигация">
        <a
          className="brand"
          href="/chat"
          onClick={(event) => {
            event.preventDefault();
            app.navigation.navigate('chat');
          }}
        >
          <span className="brand-symbol">
            <Icon name="documents" size={23} />
          </span>
          <span>
            Local RAG<small>ВАША БАЗА ЗНАНИЙ</small>
          </span>
        </a>
        <nav className="workspace-nav" aria-label="Рабочее пространство">
          {(['chat', 'documents'] as const).map((view) => (
            <button
              key={view}
              aria-current={app.view === view ? 'page' : undefined}
              onClick={() => app.navigation.navigate(view)}
            >
              <Icon name={view} />
              <span>{view === 'chat' ? 'Диалоги' : 'Документы'}</span>
            </button>
          ))}
          {user.role === 'admin' && (
            <button
              aria-current={app.view === 'admin' ? 'page' : undefined}
              onClick={() => app.navigation.navigate('admin', 'operations')}
            >
              <Icon name="settings" />
              <span>Администрирование</span>
            </button>
          )}
        </nav>
        {app.view === 'chat' && (
          <div className="sidebar-conversations">
            <Suspense fallback={<Loading />}>
              <ConversationSidebar selected={() => setSidebar(false)} />
            </Suspense>
          </div>
        )}
        {user.role === 'admin' && app.view === 'admin' && (
          <nav className="admin-navigation" aria-label="Администрирование">
            <p className="nav-label">УПРАВЛЕНИЕ</p>
            {(Object.keys(adminNames) as AdminSection[]).map((section) => (
              <button
                key={section}
                aria-current={
                  app.view === 'admin' && app.navigation.section === section ? 'page' : undefined
                }
                onClick={() => app.navigation.navigate('admin', section)}
              >
                <Icon name={section} />
                <span>{adminNames[section]}</span>
              </button>
            ))}
          </nav>
        )}
        <div className="sidebar-footer">
          <div className="local-indicator">
            <span /> Локальное рабочее пространство
          </div>
          <div className="account-row">
            <button className="account-button" onClick={() => modal(<Account />)}>
              <span className="avatar">{user.login.slice(0, 2).toUpperCase()}</span>
              <span>
                <strong>{user.login}</strong>
                <small>
                  {user.role === 'admin'
                    ? 'Администратор'
                    : user.role === 'editor'
                      ? 'Редактор'
                      : 'Пользователь'}
                </small>
              </span>
            </button>
            <Button
              className="icon-button"
              aria-label="Выйти"
              title="Выйти"
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
            Нет связи с сервером. Переподключение выполняется автоматически.
          </div>
        )}
        <header className="workspace-header">
          <button
            className="icon-button menu-toggle"
            aria-label="Открыть меню"
            aria-expanded={sidebar}
            aria-controls="sidebar"
            onClick={() => setSidebar(!sidebar)}
          >
            <Icon name="menu" />
          </button>
          <div className="breadcrumb">
            <span>Рабочее пространство</span>
            <Icon name="arrow" size={14} />
            <strong>{title}</strong>
          </div>
          <span className="workspace-tag">
            <Icon name="shield" size={14} /> Локальные данные
          </span>
        </header>
        <main
          id="main"
          tabIndex={-1}
          className={app.view === 'chat' ? 'chat-main' : 'content-main'}
        >
          <ErrorBoundary key={app.view + app.navigation.section}>
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
      <button aria-label="Скрыть уведомление" onClick={() => app.notify('')}>
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
        <Shell />
        <Notice />
      </ModalProvider>
    </ApplicationProvider>
  );
}
