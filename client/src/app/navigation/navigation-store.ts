import { makeAutoObservable } from 'mobx';
import { adminNames, adminSections, type AdminSection } from '../../features/admin/admin-sections';
export const knowledgeTabs = {
  materials: 'Materials',
  collections: 'Knowledge bases & access',
  sources: 'Connected folders',
  quality: 'Answer quality',
} as const;
export type View = 'chat' | 'documents' | 'admin';
function parseRoute(path: string): {
  view: View;
  section: AdminSection;
  conversation: string;
  tab: string;
} {
  const parts = path.split('/').filter(Boolean);
  const section =
    parts[1] && Object.hasOwn(adminNames, parts[1]) ? (parts[1] as AdminSection) : 'models';
  const tabs = parts[0] === 'knowledge' ? knowledgeTabs : adminSections[section].tabs;
  const tab = parts[0] === 'knowledge' ? parts[1] : parts[2];
  return {
    view: parts[0] === 'admin' ? 'admin' : parts[0] === 'knowledge' ? 'documents' : 'chat',
    section,
    tab: tab && Object.hasOwn(tabs, tab) ? tab : (Object.keys(tabs)[0] ?? ''),
    conversation: parts[0] === 'chat' && parts[1] ? decodeConversation(parts[1]) : '',
  };
}
function decodeConversation(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}
export class NavigationStore {
  view: View = 'chat';
  section: AdminSection = 'models';
  tab = 'assignments';
  conversation = '';
  constructor(
    private readonly onPop: () => void,
    private readonly allowPop: () => boolean = () => true,
  ) {
    if (typeof window !== 'undefined') Object.assign(this, parseRoute(window.location.pathname));
    makeAutoObservable<this, 'onPop' | 'allowPop'>(
      this,
      { onPop: false, allowPop: false },
      { autoBind: true },
    );
  }
  start() {
    if (typeof window !== 'undefined') window.addEventListener('popstate', this.pop);
  }
  dispose() {
    if (typeof window !== 'undefined') window.removeEventListener('popstate', this.pop);
  }
  private pop = () => {
    if (!this.allowPop()) {
      this.write();
      return;
    }
    Object.assign(this, parseRoute(window.location.pathname));
    this.onPop();
  };
  navigate(view: View, section: AdminSection = this.section, tab?: string) {
    const tabs = view === 'documents' ? knowledgeTabs : adminSections[section].tabs;
    const candidate = tab ?? (this.view === view && this.section === section ? this.tab : '');
    this.tab = Object.hasOwn(tabs, candidate) ? candidate : (Object.keys(tabs)[0] ?? '');
    this.view = view;
    this.section = section;
    this.write();
  }
  selectTab(tab: string) {
    this.navigate(this.view, this.section, tab);
  }
  selectConversation(id: string) {
    this.conversation = id;
    if (this.view === 'chat') this.write();
  }
  private write() {
    if (typeof window === 'undefined') return;
    const path =
      this.view === 'admin'
        ? '/admin/' + this.section + (this.tab ? '/' + this.tab : '')
        : this.view === 'documents'
          ? '/knowledge/' + (this.tab || 'materials')
          : '/chat' + (this.conversation ? '/' + encodeURIComponent(this.conversation) : '');
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
  }
}
