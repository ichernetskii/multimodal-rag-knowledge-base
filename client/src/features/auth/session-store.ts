import { makeAutoObservable, observableRef, runInAction } from 'mobx';
import { api, ApiError, request } from '../../shared/api/client';
import type { Principal, Settings } from '../../shared/api/contracts.generated';

export class SessionStore {
  user: Principal | null = null;
  phase: 'loading' | 'setup' | 'login' | 'ready' | 'error' = 'loading';
  defaults: Settings | null = null;
  epoch = 0;
  permissionsVersion = 0;
  contentVersion = 0;
  connected = true;
  private refreshing = false;
  constructor(
    private readonly afterLogin: () => Promise<void>,
    private readonly afterLogout: () => void,
    private readonly afterAccessChanged: (reset: boolean) => Promise<void>,
  ) {
    makeAutoObservable<this, 'afterLogin' | 'afterLogout' | 'afterAccessChanged' | 'refreshing'>(
      this,
      {
        user: observableRef,
        defaults: observableRef,
        afterLogin: false,
        afterLogout: false,
        afterAccessChanged: false,
        refreshing: false,
      },
      { autoBind: true },
    );
  }
  async load() {
    const version = ++this.epoch;
    const setup = await api('setup.status');
    if (version !== this.epoch) return;
    if (!setup.initialized) {
      runInAction(() => {
        this.defaults = setup.defaults ?? null;
        this.phase = 'setup';
      });
      return;
    }
    try {
      const result = await api('me');
      if (version !== this.epoch) return;
      runInAction(() => {
        this.user = result.user;
        this.permissionsVersion = result.permissionsVersion;
        this.contentVersion = result.contentVersion;
        this.connected = true;
        this.phase = 'ready';
      });
      await this.afterLogin();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.signedOut();
      else throw error;
    }
  }
  async refresh() {
    if (this.refreshing || this.phase !== 'ready') return;
    this.refreshing = true;
    const epoch = this.epoch;
    try {
      const result = await api('me');
      if (epoch !== this.epoch) return;
      const permissionsChanged = result.permissionsVersion !== this.permissionsVersion,
        changed = permissionsChanged || result.contentVersion !== this.contentVersion;
      runInAction(() => {
        this.user = result.user;
        this.permissionsVersion = result.permissionsVersion;
        this.contentVersion = result.contentVersion;
        this.connected = true;
      });
      if (changed) await this.afterAccessChanged(permissionsChanged);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.signedOut();
      else
        runInAction(() => {
          this.connected = false;
        });
    } finally {
      this.refreshing = false;
    }
  }
  async login(login: string, password: string) {
    await request('/api/login', { login, password });
    await this.load();
  }
  async logout() {
    await request('/api/logout');
    this.signedOut();
  }
  signedOut() {
    this.epoch++;
    this.user = null;
    this.defaults = null;
    this.phase = 'login';
    this.afterLogout();
  }
  failed() {
    this.phase = 'error';
  }
}
