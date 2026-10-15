import { makeAutoObservable } from 'mobx';
import { SessionStore } from '../features/auth/session-store';
import { ChatStore } from '../features/chat/chat-store';
import { JobStreamStore } from '../features/jobs/job-stream-store';
import { KnowledgeBaseStore } from '../features/knowledge-bases/knowledge-base-store';
import { NavigationStore } from './navigation/navigation-store';
import { ApiError } from '../shared/api/client';

/** Composition and navigation only. Feature state and asynchronous work belong to feature stores. */
export class ApplicationStore {
  readonly session: SessionStore;
  readonly bases: KnowledgeBaseStore;
  readonly jobs: JobStreamStore;
  readonly chat: ChatStore;
  readonly navigation: NavigationStore;
  get view() {
    return this.navigation.view;
  }
  notice = '';
  constructor() {
    this.navigation = new NavigationStore(() => {
      if (
        this.session?.phase === 'ready' &&
        this.view === 'chat' &&
        this.navigation.conversation &&
        this.navigation.conversation !== this.chat.conversation?.id
      )
        void this.execute(() => this.chat.openChat(this.navigation.conversation));
    });
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
      { session: false, bases: false, jobs: false, chat: false, navigation: false },
      { autoBind: true },
    );
  }
  private async loadWorkspace() {
    const epoch = this.session.epoch;
    await this.bases.refresh();
    if (epoch !== this.session.epoch) return;
    await this.chat.loadConversations();
    if (epoch !== this.session.epoch) return;
    const user = this.session.user;
    if (!user) return;
    const saved = this.navigation.conversation || localStorage.getItem('rag-c-' + user.id);
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
    if (this.view === 'admin' && user.role !== 'admin') this.navigation.navigate('chat');
  }
  private async refreshAccess(reset: boolean) {
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
  private resetWorkspace() {
    this.chat.reset();
    this.jobs.reset();
    this.bases.reset();
    this.navigation.navigate('chat');
    this.navigation.selectConversation('');
  }
  notify(message: string) {
    this.notice = message;
  }
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
    try {
      await this.session.load();
    } catch (error) {
      this.session.failed();
      throw error;
    }
  }
  dispose() {
    this.navigation.dispose();
    this.chat.dispose();
    this.jobs.closeConnections();
  }
}
