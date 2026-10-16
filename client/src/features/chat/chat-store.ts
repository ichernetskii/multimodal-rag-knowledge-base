import { makeAutoObservable, observableRef, observableShallow, runInAction } from 'mobx';
import { api } from '../../shared/api/client';
import type {
  Conversation,
  ConversationDetails,
  SearchScope,
} from '../../shared/api/contracts.generated';
import { terminal } from '../../shared/api/contracts.generated';
import type { SessionStore } from '../auth/session-store';
import type { JobSnapshot, JobStreamStore } from '../jobs/job-stream-store';
import { conversationBranch } from './conversation-branch';
export class ChatStore {
  conversations: Conversation[] = [];
  conversationTotal = 0;
  conversationPage = 1;
  conversationQuery = '';
  private listRequest = 0;
  conversation: Conversation | null = null;
  turns: ConversationDetails['turns'] = [];
  scope: SearchScope = {};
  attachments: string[] = [];
  profile = '';
  private submissionKey = '';
  private submissionFingerprint = '';
  draft = '';
  busy = false;
  loadingChat = false;
  loadingOlder = false;
  historyBefore = '';
  variantCounts: Record<string, number> = {};
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private chatRequest = 0;
  constructor(
    private readonly session: SessionStore,
    private readonly jobs: JobStreamStore,
    private readonly execute: (work: () => Promise<unknown>) => Promise<void>,
    private readonly onOpen: (id: string) => void,
  ) {
    makeAutoObservable<
      this,
      | 'session'
      | 'jobs'
      | 'execute'
      | 'draftTimer'
      | 'saving'
      | 'chatRequest'
      | 'listRequest'
      | 'onOpen'
    >(
      this,
      {
        conversations: observableShallow,
        turns: observableShallow,
        conversation: observableRef,
        scope: observableRef,
        variantCounts: observableRef,
        session: false,
        onOpen: false,
        listRequest: false,
        jobs: false,
        execute: false,
        draftTimer: false,
        saving: false,
        chatRequest: false,
      },
      { autoBind: true },
    );
  }
  receive(snapshot: JobSnapshot) {
    if (!snapshot.turn || snapshot.turn.conversation !== this.conversation?.id) return;
    const i = this.turns.findIndex((t) => t.id === snapshot.turn!.id);
    if (i < 0) this.turns.push(snapshot.turn);
    else this.turns[i] = snapshot.turn;
  }
  dispose() {
    clearTimeout(this.draftTimer);
    this.chatRequest++;
    this.jobs.closeChatConnections();
  }
  reset() {
    this.dispose();
    this.listRequest++;
    this.conversations = [];
    this.conversationTotal = 0;
    this.conversationPage = 1;
    this.conversationQuery = '';
    this.conversation = null;
    this.turns = [];
    this.historyBefore = '';
    this.variantCounts = {};
    this.loadingOlder = false;
    this.scope = {};
    this.attachments = [];
    this.draft = '';
    this.busy = false;
    this.loadingChat = false;
  }
  toggleAttachment(id: string) {
    this.attachments = this.attachments.includes(id)
      ? this.attachments.filter((value) => value !== id)
      : [...this.attachments, id].slice(0, 3);
  }
  get branch() {
    return conversationBranch(this.turns, this.conversation?.selected ?? '');
  }
  async loadConversations(query = this.conversationQuery, page = 1) {
    const request = ++this.listRequest;
    const epoch = this.session.epoch;
    const data = await api('conversations.list', { query, page, pageSize: 25 });
    if (epoch !== this.session.epoch || request !== this.listRequest) return;
    runInAction(() => {
      this.conversations = page > 1 ? [...this.conversations, ...data.items] : data.items;
      this.conversationTotal = data.total;
      this.conversationPage = page;
      this.conversationQuery = query;
    });
  }
  async newChat() {
    const epoch = this.session.epoch;
    const c = await api('conversations.create');
    if (epoch !== this.session.epoch) return;
    await this.loadConversations();
    await this.openChat(c.id);
  }
  async openChat(id: string) {
    const epoch = this.session.epoch;
    await this.flushDraft();
    if (epoch !== this.session.epoch) return;
    this.dispose();
    const sequence = ++this.chatRequest;
    runInAction(() => {
      this.loadingChat = true;
    });
    try {
      const data = await api('conversations.read', { id });
      if (sequence !== this.chatRequest || epoch !== this.session.epoch) return;
      runInAction(() => {
        this.submissionFingerprint = '';
        this.conversation = data.conversation;
        this.attachments = [];
        this.turns = data.turns;
        this.historyBefore = data.history.before;
        this.variantCounts = data.variantCounts;
        this.jobs.replaceChat(data.jobs);
        this.draft = localStorage.getItem('rag-draft-' + id) ?? data.conversation.draft;
        const selected = data.turns.find((t) => t.id === data.conversation.selected);
        this.scope = selected ? { collection: selected.scope.collection } : {};
        this.onOpen(id);
        if (this.session.user) localStorage.setItem('rag-c-' + this.session.user.id, id);
      });
      for (const job of data.jobs) if (!terminal.has(job.status)) this.jobs.watch(job);
    } finally {
      if (sequence === this.chatRequest)
        runInAction(() => {
          this.loadingChat = false;
        });
    }
  }
  setDraft(value: string) {
    this.draft = value;
    if (!this.conversation) return;
    localStorage.setItem('rag-draft-' + this.conversation.id, value);
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      void this.execute(() => this.flushDraft());
    }, 500);
  }
  async flushDraft() {
    clearTimeout(this.draftTimer);
    const epoch = this.session.epoch;
    const operation = this.saving.then(async () => {
      if (epoch !== this.session.epoch) return;
      const c = this.conversation,
        draft = this.draft;
      if (!c || c.draft === draft) return;
      const updated = await api('conversations.save', {
        id: c.id,
        revision: c.revision,
        draft,
      });
      runInAction(() => {
        if (epoch === this.session.epoch && this.conversation?.id === c.id)
          this.conversation = updated;
      });
    });
    this.saving = operation.catch(() => undefined);
    await operation;
  }
  async saveConversation(change: Partial<Pick<Conversation, 'title' | 'selected'>>) {
    const epoch = this.session.epoch;
    await this.flushDraft();
    if (epoch !== this.session.epoch) return;
    const c = this.conversation;
    if (!c) return;
    const updated = await api('conversations.save', {
      id: c.id,
      revision: c.revision,
      ...change,
    });
    runInAction(() => {
      if (epoch === this.session.epoch && this.conversation?.id === c.id)
        this.conversation = updated;
    });
    if (change.selected !== undefined) await this.refreshChat(true);
    await this.loadConversations();
  }
  async refreshChat(reset = false) {
    const epoch = this.session.epoch;
    const sequence = this.chatRequest;
    const id = this.conversation?.id;
    if (!id) return;
    if (reset) {
      this.jobs.closeChatConnections();
      runInAction(() => {
        this.turns = [];
        this.historyBefore = '';
        this.variantCounts = {};
      });
    }
    const data = await api('conversations.read', { id });
    runInAction(() => {
      if (
        epoch === this.session.epoch &&
        sequence === this.chatRequest &&
        this.conversation?.id === id
      ) {
        const changed = this.conversation?.selected !== data.conversation.selected;
        this.submissionFingerprint = '';
        this.conversation = data.conversation;
        if (changed || reset)
          this.scope = {
            collection: data.turns.find((turn) => turn.id === data.conversation.selected)?.scope
              .collection,
          };
        if (reset) {
          this.turns = data.turns;
          this.historyBefore = data.history.before;
          this.variantCounts = data.variantCounts;
        } else {
          const merged = new Map(this.turns.map((turn) => [turn.id, turn]));
          for (const turn of data.turns) merged.set(turn.id, turn);
          this.turns = [...merged.values()];
          this.variantCounts = { ...this.variantCounts, ...data.variantCounts };
          const branch = conversationBranch(this.turns, data.conversation.selected),
            oldest = branch[0];
          this.historyBefore = oldest?.parent && !merged.has(oldest.parent) ? oldest.id : '';
        }
        this.jobs.replaceChat(data.jobs);
      }
    });
    if (epoch === this.session.epoch && sequence === this.chatRequest)
      for (const job of data.jobs) if (!terminal.has(job.status)) this.jobs.watch(job);
  }
  async loadOlder() {
    const id = this.conversation?.id,
      before = this.historyBefore,
      epoch = this.session.epoch,
      sequence = this.chatRequest;
    if (!id || !before || this.loadingOlder) return;
    this.loadingOlder = true;
    try {
      const data = await api('conversations.read', { id, before });
      if (epoch !== this.session.epoch || sequence !== this.chatRequest) return;
      if (data.conversation.selected !== this.conversation?.selected) {
        await this.refreshChat();
        return;
      }
      runInAction(() => {
        const known = new Set(this.turns.map((turn) => turn.id));
        this.turns = [...data.turns.filter((turn) => !known.has(turn.id)), ...this.turns];
        this.historyBefore = data.history.before;
        this.variantCounts = { ...this.variantCounts, ...data.variantCounts };
        for (const job of data.jobs) this.jobs.upsert(job);
      });
      for (const job of data.jobs) if (!terminal.has(job.status)) this.jobs.watch(job);
    } finally {
      if (epoch === this.session.epoch && sequence === this.chatRequest)
        runInAction(() => {
          this.loadingOlder = false;
        });
    }
  }
  async send(question = this.draft, replaces = '') {
    if (!question.trim() || !this.conversation || this.busy) return;
    const epoch = this.session.epoch;
    this.busy = true;
    try {
      await this.flushDraft();
      const c = this.conversation;
      if (!c) return;
      if (epoch !== this.session.epoch) return;
      const fingerprint = JSON.stringify({
        conversation: c.id,
        question,
        attachments: this.attachments,
        replaces,
        scope: this.scope,
        profile: this.profile,
      });
      if (fingerprint !== this.submissionFingerprint) {
        this.submissionFingerprint = fingerprint;
        this.submissionKey = crypto.randomUUID();
      }
      const data = await api('answers.create', {
        idempotencyKey: this.submissionKey,
        ...(this.profile ? { profile: this.profile } : {}),
        conversation: c.id,
        revision: c.revision,
        question,
        attachments: replaces
          ? (this.turns.find((turn) => turn.id === replaces)?.attachments ?? [])
          : this.attachments,
        replaces,
        scope: this.scope,
      });
      if (epoch !== this.session.epoch || this.conversation?.id !== c.id) return;
      runInAction(() => {
        this.submissionFingerprint = '';
        this.conversation = data.conversation;
        this.turns.push(data.turn);
        this.variantCounts = {
          ...this.variantCounts,
          [data.turn.parent]: (this.variantCounts[data.turn.parent] ?? 0) + 1,
        };
        this.jobs.upsert(data.job);
        this.draft = '';
        localStorage.removeItem('rag-draft-' + c.id);
      });
      this.jobs.watch(data.job);
      await this.loadConversations();
    } finally {
      runInAction(() => {
        if (epoch === this.session.epoch) this.busy = false;
      });
    }
  }
}
