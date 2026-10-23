import { makeAutoObservable } from 'mobx';
type Scope = 'page' | 'dialog';
/** Form values stay in the form; this store keeps only identifiers of dirty forms. */
export class UnsavedChanges {
  private forms = new Map<string, Scope>();
  constructor(
    private readonly confirm = () =>
      window.confirm('You have unsaved changes. Leave this form and discard them?'),
  ) {
    makeAutoObservable<this, 'confirm'>(this, { confirm: false }, { autoBind: true });
  }
  get dirty() {
    return this.forms.size > 0;
  }
  mark(id: string, scope: Scope) {
    this.forms.set(id, scope);
  }
  clear(id?: string) {
    if (id) this.forms.delete(id);
    else this.forms.clear();
  }
  confirmDiscard(scope?: Scope) {
    const pending = [...this.forms].filter(([, value]) => !scope || value === scope);
    if (!pending.length) return true;
    if (!this.confirm()) return false;
    for (const [id] of pending) this.forms.delete(id);
    return true;
  }
}
