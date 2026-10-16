import { makeAutoObservable } from 'mobx';
import { adminNames, type AdminSection } from '../../features/admin/admin-sections';
type View = 'chat' | 'documents' | 'admin';
function parseRoute(path: string): {
  view: View;
  section: AdminSection;
  conversation: string;
} {
  const parts = path.split('/').filter(Boolean);
  return {
    view: parts[0] === 'admin' ? 'admin' : parts[0] === 'documents' ? 'documents' : 'chat',
    section:
      parts[1] && Object.hasOwn(adminNames, parts[1]) ? (parts[1] as AdminSection) : 'overview',
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
  section: AdminSection = 'overview';
  conversation = '';
  constructor(private readonly onPop: () => void) {
    if (typeof window !== 'undefined') Object.assign(this, parseRoute(window.location.pathname));
    makeAutoObservable<this, 'onPop'>(this, { onPop: false }, { autoBind: true });
  }
  start() {
    if (typeof window !== 'undefined') window.addEventListener('popstate', this.pop);
  }
  dispose() {
    if (typeof window !== 'undefined') window.removeEventListener('popstate', this.pop);
  }
  private pop = () => {
    Object.assign(this, parseRoute(window.location.pathname));
    this.onPop();
  };
  navigate(view: View, section: AdminSection = this.section) {
    this.view = view;
    this.section = section;
    this.write();
  }
  selectConversation(id: string) {
    this.conversation = id;
    if (this.view === 'chat') this.write();
  }
  private write() {
    if (typeof window === 'undefined') return;
    const path =
      this.view === 'admin'
        ? '/admin/' + this.section
        : this.view === 'documents'
          ? '/documents'
          : '/chat' + (this.conversation ? '/' + encodeURIComponent(this.conversation) : '');
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
  }
}
