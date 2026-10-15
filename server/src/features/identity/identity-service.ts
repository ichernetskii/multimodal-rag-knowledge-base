import { randomUUID } from 'node:crypto';
import { authorized, type ActionMap } from '../../application/action-registry.js';
import type { DataContext } from '../../application/data-context.js';
import type { Principal, User, Group } from '../../domain/entities.js';
import { requireValue } from '../../shared/errors.js';
import type { Input } from '../../shared/input.js';
import { revision, string, strings } from '../../shared/input.js';
import { pagination } from '../../shared/pagination.js';
import { passwordHash, publicUser } from './auth-service.js';

export class IdentityService {
  constructor(private readonly data: DataContext) {}
  readonly actions: ActionMap = {
    me: authorized((user) => this.handleMe(user)),
    'sessions.list': authorized((user) => this.handleSessionsList(user)),
    'sessions.revoke': authorized((user, p) => this.handleSessionsRevoke(user, p)),
    'password.change': authorized((user, p) => this.handlePasswordChange(user, p)),
    'users.list': authorized((user, p) => this.handleUsersList(user, p)),
    'users.create': authorized((user, p) => this.handleUsersCreate(user, p)),
    'users.update': authorized((user, p) => this.handleUsersUpdate(user, p)),
    'users.revoke': authorized((user, p) => this.handleUsersRevoke(user, p)),
    'groups.list': authorized((user) => this.handleGroupsList(user)),
    'groups.save': authorized((user, p) => this.handleGroupsSave(user, p)),
  };
  async handleMe(user: Principal) {
    return {
      user,
      permissionsVersion: this.data.catalog.accessEpoch(),
      contentVersion: this.data.catalog.epoch(),
    };
  }

  async handleSessionsList(user: Principal) {
    return this.data.catalog
      .prepare('SELECT created,expires,token AS id FROM sessions WHERE user=?')
      .all(user.id)
      .map((row) => ({
        id: String(row.id),
        created: Number(row.created),
        expires: Number(row.expires),
      }));
  }

  async handleSessionsRevoke(user: Principal, p: Input) {
    const id = string(p, 'id');
    this.data.catalog.prepare('DELETE FROM sessions WHERE user=? AND token=?').run(user.id, id);
    return { ok: true };
  }

  async handlePasswordChange(user: Principal, p: Input) {
    const u = this.data.catalog.get<User>('user', user.id)!;
    const { passwordMatches } = await import('./auth-service.js');
    requireValue(
      await passwordMatches(string(p, 'oldPassword'), u.password),
      'AUTH_FAILED',
      'Неверный пароль.',
      401,
    );
    const pw = await passwordHash(string(p, 'password'));
    const fresh = this.data.catalog.get<User>('user', user.id)!;
    requireValue(fresh.password === u.password, 'REVISION_CONFLICT', 'Пароль был изменён.', 409);
    fresh.password = pw;
    fresh.revision++;
    this.data.catalog.put('user', fresh);
    this.data.auth.revoke(user.id);
    return { ok: true };
  }

  async handleUsersList(user: Principal, p: Input) {
    this.data.auth.admin(user);
    const page = pagination(p),
      q = string(p, 'query').toLowerCase(),
      role = string(p, 'role'),
      state = string(p, 'state');
    requireValue(
      !role || ['user', 'editor', 'admin'].includes(role),
      'INVALID_INPUT',
      'Неверная роль.',
    );
    requireValue(
      !state || ['active', 'blocked'].includes(state),
      'INVALID_INPUT',
      'Неверное состояние.',
    );
    const ids = strings(p, 'ids'),
      where =
        "(?='' OR instr(search_name,?)>0) AND (?='' OR role=?) AND (?='' OR blocked=?) AND (?=0 OR id IN (SELECT value FROM json_each(?)))",
      params = [
        q,
        q,
        role,
        role,
        state,
        state === 'blocked' ? 1 : 0,
        ids.length,
        JSON.stringify(ids),
      ];
    return {
      items: this.data.catalog
        .find<User>('user', where, params, 'search_name', page.pageSize, page.offset)
        .map(publicUser),
      total: this.data.catalog.count('user', where, params),
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async handleUsersCreate(user: Principal, p: Input) {
    this.data.auth.admin(user);
    requireValue(
      p.blocked === undefined || typeof p.blocked === 'boolean',
      'INVALID_INPUT',
      'blocked должен быть boolean.',
    );
    return this.data.auth.create(
      string(p, 'login'),
      string(p, 'password'),
      string(p, 'role', 'user') as User['role'],
      { groups: strings(p, 'groups'), blocked: p.blocked === true },
      () => this.data.auth.admin(this.data.auth.current(user.id)),
    );
  }

  async handleUsersUpdate(user: Principal, p: Input) {
    this.data.auth.admin(user);
    const old = this.data.catalog.get<User>('user', string(p, 'id'));
    requireValue(old, 'NOT_FOUND', 'Пользователь не найден.', 404);
    revision(p, old);
    const role = string(p, 'role', old.role);
    requireValue(['user', 'editor', 'admin'].includes(role), 'INVALID_ROLE', 'Некорректная роль.');
    const blocked = p.blocked === undefined ? old.blocked : p.blocked;
    requireValue(typeof blocked === 'boolean', 'INVALID_INPUT', 'blocked должен быть boolean.');
    requireValue(
      !(
        old.role === 'admin' &&
        (role !== 'admin' || blocked) &&
        this.data.catalog.count('user', "role='admin' AND blocked=0") === 1
      ),
      'LAST_ADMIN',
      'Нельзя отключить последнего администратора.',
    );
    const pw = p.password === undefined ? old.password : await passwordHash(string(p, 'password'));
    this.data.auth.admin(this.data.auth.current(user.id));
    revision(p, this.data.catalog.get<User>('user', old.id)!);
    requireValue(
      !(
        old.role === 'admin' &&
        (role !== 'admin' || blocked) &&
        this.data.catalog.count('user', "role='admin' AND blocked=0") === 1
      ),
      'LAST_ADMIN',
      'Нельзя отключить последнего администратора.',
    );
    const groups = p.groups === undefined ? old.groups : strings(p, 'groups');
    for (const id of groups)
      requireValue(this.data.catalog.get('group', id), 'INVALID_GROUP', 'Группа не найдена.');
    const next = {
      ...old,
      role: role as User['role'],
      blocked,
      groups,
      password: pw,
      revision: old.revision + 1,
    };
    this.data.catalog.transaction(() => {
      this.data.catalog.put('user', next);
      this.data.auth.revoke(old.id);
    });
    return publicUser(next);
  }

  async handleUsersRevoke(user: Principal, p: Input) {
    this.data.auth.admin(user);
    this.data.auth.revoke(string(p, 'id'));
    return { ok: true };
  }

  async handleGroupsList(user: Principal) {
    this.data.auth.admin(user);
    return this.data.catalog.list<Group>('group');
  }

  async handleGroupsSave(user: Principal, p: Input) {
    this.data.auth.admin(user);
    const id = string(p, 'id', randomUUID());
    const old = this.data.catalog.get<{ id: string; revision: number }>('group', id);
    if (old) revision(p, old);
    const group = { id, name: string(p, 'name'), revision: (old?.revision ?? 0) + 1 };
    requireValue(group.name.trim(), 'INVALID_INPUT', 'Введите название группы.');
    this.data.catalog.transaction(() => {
      this.data.catalog.put('group', group);
      this.data.catalog.invalidate();
    });
    return group;
  }
}
