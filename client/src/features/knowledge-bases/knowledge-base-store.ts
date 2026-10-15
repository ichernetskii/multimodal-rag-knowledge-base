import { makeAutoObservable, observableShallow, runInAction } from 'mobx';
import { api } from '../../shared/api/client';
import type { Collection } from '../../shared/api/contracts.generated';
import { canEditCollection } from '../../shared/lib/permissions';
import type { SessionStore } from '../auth/session-store';

export class KnowledgeBaseStore {
  items: Collection[] = [];
  constructor(private readonly session: SessionStore) {
    makeAutoObservable<this, 'session'>(
      this,
      { items: observableShallow, session: false },
      { autoBind: true },
    );
  }
  async refresh() {
    const epoch = this.session.epoch,
      data = await api('collections.list');
    if (epoch === this.session.epoch)
      runInAction(() => {
        this.items = data;
      });
  }
  canEdit(collection: Collection) {
    return canEditCollection(this.session.user, collection);
  }
  reset() {
    this.items = [];
  }
}
