import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runInAction } from 'mobx';
import {
  adminGroups,
  adminSections,
  canAccessAdmin,
  canAccessAdminTab,
} from '../src/features/admin/admin-sections';
import { ApplicationStore } from '../src/app/application-store';
beforeEach(() => {
  for (const name of ['localStorage', 'sessionStorage']) {
    const data = new Map<string, string>();
    vi.stubGlobal(name, {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    });
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      const action = path.split('/').at(-1);
      const value =
        action === 'setup.status'
          ? { initialized: true }
          : action === 'me'
            ? {
                user: {
                  id: 'u',
                  login: 'admin',
                  tenant: 'b',
                  role: 'admin',
                  operator: false,
                  groups: [],
                },
                tenants: [
                  { id: 'b', name: 'Company B', role: 'admin', blocked: false, revision: 1 },
                ],
                permissionsVersion: 1,
                contentVersion: 1,
              }
            : action === 'collections.list'
              ? []
              : { items: [], total: 0, page: 1, pageSize: 25 };
      return new Response(JSON.stringify(value), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('separates company administration from platform ownership', () => {
  const admin = { role: 'admin', operator: false } as const;
  const sections = adminGroups(admin).flatMap((g) => g.sections);
  expect(sections).toContain('models');
  expect(sections).toContain('maintenance');
  expect(sections).toContain('usage');
  for (const section of ['credentials', 'system'] as const) {
    expect(canAccessAdmin(section, admin)).toBe(false);
    expect(sections).not.toContain(section);
    expect(canAccessAdmin(section, { ...admin, operator: true })).toBe(true);
  }
  expect(Object.keys(adminSections)).not.toContain('saas');
});
it('does not give company management to editors or ordinary users', () => {
  for (const role of ['editor', 'user'] as const) {
    expect(adminGroups({ role, operator: false })).toEqual([]);
    expect(canAccessAdmin('maintenance', { role, operator: false })).toBe(false);
  }
});
it('keeps a permitted administration section when switching company', async () => {
  const app = new ApplicationStore();
  runInAction(() => {
    app.navigation.navigate('admin', 'models');
  });
  await app.switchCompany('b');
  expect(app.view).toBe('admin');
  expect(app.navigation.section).toBe('models');
  app.dispose();
});
it('does not carry platform navigation into an unprivileged company session', async () => {
  const app = new ApplicationStore();
  runInAction(() => {
    app.navigation.navigate('admin', 'credentials');
  });
  await app.switchCompany('b');
  expect(app.navigation.section).toBe('models');
  app.dispose();
});

it('preserves a new navigation choice made while company data is loading', async () => {
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>((r) => {
    release = r;
  });
  const loading = new Promise<void>((r) => {
    started = r;
  });
  const request = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options: RequestInit) => {
      if (path.endsWith('collections.list')) {
        started();
        await pending;
      }
      return request(path, options);
    }),
  );
  const app = new ApplicationStore();
  runInAction(() => app.navigation.navigate('admin', 'models'));
  const switching = app.switchCompany('b');
  await loading;
  runInAction(() => app.navigation.navigate('admin', 'usage'));
  release();
  await switching;
  expect(app.navigation.section).toBe('usage');
  app.dispose();
});

it('keeps company model profiles separate from global API keys', () => {
  const admin = { role: 'admin', operator: false } as const;
  expect(adminSections.models.scope).toBe('company');
  expect(adminSections.credentials.scope).toBe('platform');
  expect(canAccessAdminTab('models', 'assignments', admin)).toBe(true);
  expect(canAccessAdminTab('models', 'connections', admin)).toBe(false);
  expect(canAccessAdminTab('models', 'connections', { ...admin, operator: true })).toBe(true);
});
it('treats platform ownership independently from the company role', () => {
  const owner = { role: 'user', operator: true } as const;
  expect(canAccessAdmin('credentials', owner)).toBe(true);
  expect(canAccessAdmin('models', owner)).toBe(false);
});
it('retains the maintenance tab when changing company', async () => {
  const app = new ApplicationStore();
  runInAction(() => app.navigation.navigate('admin', 'maintenance', 'backups'));
  await app.switchCompany('b');
  expect(app.navigation.section).toBe('maintenance');
  expect(app.navigation.tab).toBe('backups');
  app.dispose();
});
