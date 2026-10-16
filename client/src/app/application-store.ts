import { makeAutoObservable } from 'mobx';
import { SessionStore } from '../features/auth/session-store';
import { ChatStore } from '../features/chat/chat-store';
import { JobStreamStore } from '../features/jobs/job-stream-store';
import { KnowledgeBaseStore } from '../features/knowledge-bases/knowledge-base-store';
import { NavigationStore, type View } from './navigation/navigation-store';
import { UnsavedChanges } from './navigation/unsaved-changes';
import type { AdminSection } from '../features/admin/admin-sections';
import { canAccessAdmin, canAccessAdminTab } from '../features/admin/admin-sections';
import { ApiError } from '../shared/api/client';

/** Composition and navigation only. Feature state and asynchronous work belong to feature stores. */
export class ApplicationStore {
  readonly session: SessionStore;
  readonly bases: KnowledgeBaseStore;
  readonly jobs: JobStreamStore;
  readonly chat: ChatStore;
  readonly navigation: NavigationStore;
  readonly unsaved = new UnsavedChanges();
  get view() {
    return this.navigation.view;
  }
  notice = '';
  constructor() {
    this.navigation = new NavigationStore(
      () => {
        if (
          this.session?.phase === 'ready' &&
          this.view === 'chat' &&
          this.navigation.conversation &&
          this.navigation.conversation !== this.chat.conversation?.id
        )
          void this.execute(() => this.chat.openChat(this.navigation.conversation));
      },
      () => this.unsaved.confirmDiscard(),
    );
    this.session = new SessionStore(
      () => this.loadWorkspace(),
      () => this.resetWorkspace(),
      (reset) => this.refreshAccess(reset),
    );
    this.bases = new KnowledgeBaseStore(this.session);
    this.jobs = new JobStreamStore(
      (snapshot) => this.chat.receive(snapshot),
      (error) => {
        this.notify(
          error instanceof Error
            ? error.message
            : typeof error === 'object' && error && 'message' in error
              ? String(error.message)
              : 'Ошибка потока',
        );
        void this.execute(() => this.chat.refreshChat());
      },
    );
    this.chat = new ChatStore(
      this.session,
      this.jobs,
      (work) => this.execute(work),
      (id) => this.navigation.selectConversation(id),
    );
    makeAutoObservable(
      this,
      { session: false, bases: false, jobs: false, chat: false, navigation: false, unsaved: false },
      { autoBind: true },
    );
  }
  async switchCompany(id: string) {
    if (id === this.session.user?.tenant || !this.unsaved.confirmDiscard()) return;
    const view = this.view,
      section = this.navigation.section,
      tab = this.navigation.tab;
    await this.session.switchTenant(id);
    const user = this.session.user;
    if (view === 'admin' && this.view === 'chat' && user?.tenant === id) {
      this.navigation.navigate('admin', canAccessAdmin(section, user) ? section : 'models', tab);
      this.clampNavigation();
    } else if (view === 'documents' && this.view === 'chat' && user?.tenant === id)
      this.navigation.navigate('documents', section, tab);
  }
  private async loadWorkspace() {
    const epoch = this.session.epoch;
    await this.bases.refresh();
    if (epoch !== this.session.epoch) return;
    await this.chat.loadConversations();
    if (epoch !== this.session.epoch) return;
    const user = this.session.user;
    if (!user) return;
    const saved =
      this.navigation.conversation || localStorage.getItem('rag-c-' + user.tenant + ':' + user.id);
    const selected = saved ?? this.chat.conversations[0]?.id;
    if (selected)
      try {
        await this.chat.openChat(selected);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          this.navigation.selectConversation('');
          if (this.chat.conversations[0]) await this.chat.openChat(this.chat.conversations[0].id);
        } else throw error;
      }
    this.clampScope();
    this.clampNavigation();
  }
  private async refreshAccess(reset: boolean) {
    if (reset) this.unsaved.clear();
    const epoch = this.session.epoch;
    if (reset) this.jobs.reset();
    await this.bases.refresh();
    if (epoch !== this.session.epoch) return;
    try {
      await this.chat.refreshChat(reset);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) this.chat.reset();
      else throw error;
    }
    if (epoch !== this.session.epoch) return;
    this.clampScope();
    this.clampNavigation();
    await this.chat.loadConversations();
    if (!this.chat.conversation && this.chat.conversations[0])
      await this.chat.openChat(this.chat.conversations[0].id);
  }
  private clampScope() {
    if (
      this.chat.scope.collection &&
      !this.bases.items.some((base) => base.id === this.chat.scope.collection)
    )
      this.chat.scope = {};
  }
  private clampNavigation() {
    const user = this.session.user;
    if (user && this.view === 'admin' && !canAccessAdmin(this.navigation.section, user))
      this.navigation.navigate(user.role === 'admin' ? 'admin' : 'documents', 'models');
    else if (
      user &&
      this.view === 'admin' &&
      !canAccessAdminTab(this.navigation.section, this.navigation.tab, user)
    )
      this.navigation.selectTab('assignments');
  }
  private resetWorkspace() {
    this.unsaved.clear();
    this.chat.reset();
    this.jobs.reset();
    this.bases.reset();
    this.navigation.navigate('chat');
    this.navigation.selectConversation('');
  }
  notify(message: string) {
    this.notice = message;
  }
  navigate(view: View, section?: AdminSection, tab?: string) {
    if (this.unsaved.confirmDiscard()) this.navigation.navigate(view, section, tab);
  }
  selectTab(tab: string) {
    if (this.unsaved.confirmDiscard()) this.navigation.selectTab(tab);
  }
  private beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.unsaved.dirty) event.preventDefault();
  };
  handleError(error: unknown, notify = true) {
    if (notify)
      this.notice = error instanceof Error ? error.message : 'Не удалось выполнить действие.';
    if (error instanceof ApiError && error.status === 401 && error.code !== 'AUTH_FAILED')
      this.session.signedOut();
  }
  async execute(work: () => Promise<unknown>) {
    try {
      await work();
    } catch (error) {
      this.handleError(error);
    }
  }
  async boot() {
    this.navigation.start();
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', this.beforeUnload);
    try {
      await this.session.load();
    } catch (error) {
      this.session.failed();
      throw error;
    }
  }
  dispose() {
    if (typeof window !== 'undefined')
      window.removeEventListener('beforeunload', this.beforeUnload);
    this.navigation.dispose();
    this.chat.dispose();
    this.jobs.closeConnections();
  }
}
