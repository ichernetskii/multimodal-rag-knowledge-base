import { scrypt as derive, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Collection, DocumentRecord, Principal, User } from '../../domain/entities.js';
import type { Catalog } from '../../infrastructure/database/catalog.js';
import { requireValue } from '../../shared/errors.js';
import { hash } from '../../shared/hash.js';
const scrypt = promisify(derive);
export async function passwordHash(password: string) {
  requireValue(
    password.length >= 12 && password.length <= 256,
    'PASSWORD_POLICY',
    'Пароль должен содержать от 12 до 256 символов.',
  );
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + ((await scrypt(password, salt, 64)) as Buffer).toString('hex');
}
export async function passwordMatches(password: string, stored: string) {
  const [salt, key] = stored.split(':');
  const candidate = (await scrypt(password, salt ?? 'invalid', 64)) as Buffer;
  const expected = Buffer.from(key ?? '', 'hex');
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}
export function publicUser(user: User): Principal & { blocked: boolean; revision: number } {
  return {
    id: user.id,
    login: user.login,
    role: user.role,
    groups: user.groups,
    blocked: user.blocked,
    revision: user.revision,
  };
}
export class Auth {
  private attempts = new Map<string, { count: number; since: number }>();
  constructor(private readonly catalog: Catalog) {}
  async login(login: string, password: string, address: string) {
    requireValue(password.length <= 256, 'AUTH_FAILED', 'Неверный логин или пароль.', 401);
    const key = address;
    const attempt = this.attempts.get(key);
    requireValue(
      !attempt || attempt.count < 10 || Date.now() - attempt.since > 60_000,
      'RATE_LIMIT',
      'Подождите перед следующей попыткой.',
      429,
    );
    if (this.attempts.size > 1000) this.attempts.clear();
    this.attempts.set(key, {
      count: attempt && Date.now() - attempt.since < 60_000 ? attempt.count + 1 : 1,
      since: attempt?.since ?? Date.now(),
    });
    const user = this.catalog.find<User>('user', 'name=?', [login], 'id', 1)[0];
    const valid = await passwordMatches(password, user?.password ?? 'invalid:');
    requireValue(user && !user.blocked && valid, 'AUTH_FAILED', 'Неверный логин или пароль.', 401);
    const fresh = this.catalog.get<User>('user', user.id);
    requireValue(
      fresh && !fresh.blocked && fresh.password === user.password,
      'AUTH_FAILED',
      'Учётная запись изменена. Повторите вход.',
      401,
    );
    this.attempts.delete(key);
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.catalog
      .prepare('INSERT INTO sessions VALUES (?,?,?,?)')
      .run(hash(token), user.id, now + this.catalog.settings().sessionHours * 3600_000, now);
    return { token, user: publicUser(fresh) };
  }
  principal(token: string): Principal {
    const session = this.catalog
      .prepare('SELECT user,expires FROM sessions WHERE token=?')
      .get(hash(token));
    const user = session ? this.catalog.get<User>('user', String(session.user)) : undefined;
    requireValue(
      user && !user.blocked && Number(session?.expires) > Date.now(),
      'UNAUTHENTICATED',
      'Войдите в систему.',
      401,
    );
    return publicUser(user);
  }
  current(id: string): Principal {
    const user = this.catalog.get<User>('user', id);
    requireValue(user && !user.blocked, 'ACCESS_REVOKED', 'Доступ отозван.', 403);
    return publicUser(user);
  }
  logout(token: string) {
    this.catalog.prepare('DELETE FROM sessions WHERE token=?').run(hash(token));
  }
  revoke(id: string) {
    this.catalog.transaction(() => {
      this.catalog.prepare('DELETE FROM sessions WHERE user=?').run(id);
      this.catalog.invalidate(true);
    });
  }
  admin(user: Principal) {
    requireValue(user.role === 'admin', 'FORBIDDEN', 'Требуется роль администратора.', 403);
  }
  collection(user: Principal, id: string, edit = false) {
    const collection = this.catalog.get<Collection>('collection', id);
    requireValue(collection, 'NOT_FOUND', 'База знаний не найдена.', 404);
    if (user.role === 'admin') return collection;
    const subjects = new Set([user.id, ...user.groups.map((g) => 'group:' + g)]);
    requireValue(
      collection.grants.some((g) => subjects.has(g.subject) && (!edit || g.access === 'edit')) &&
        (!edit || user.role === 'editor'),
      'FORBIDDEN',
      'Нет доступа к базе знаний.',
      403,
    );
    return collection;
  }
  collections(user: Principal, edit = false): Collection[] {
    if (user.role === 'admin') return this.catalog.find<Collection>('collection');
    if (edit && user.role !== 'editor') return [];
    const subjects = JSON.stringify([user.id, ...user.groups.map((id) => 'group:' + id)]);
    return this.catalog.find<Collection>(
      'collection',
      `EXISTS (SELECT 1 FROM json_each(body,'$.grants') AS grant WHERE json_extract(grant.value,'$.subject') IN (SELECT value FROM json_each(?)) AND (?=0 OR json_extract(grant.value,'$.access')='edit'))`,
      [subjects, edit ? 1 : 0],
    );
  }
  documentScope(user: Principal) {
    const read = JSON.stringify(this.collections(user).map((c) => c.id));
    const edit = JSON.stringify(this.collections(user, true).map((c) => c.id));
    return {
      where: `((conversation!='' AND owner=?) OR (coalesce(conversation,'')='' AND collection IN (SELECT value FROM json_each(?)) AND (state!='draft' OR collection IN (SELECT value FROM json_each(?)))))`,
      params: [user.id, read, edit],
    };
  }
  canRead(user: Principal, doc: DocumentRecord) {
    if (doc.conversation) return doc.owner === user.id;
    try {
      this.collection(user, doc.collection, doc.state === 'draft');
      return true;
    } catch {
      return false;
    }
  }
  document(user: Principal, id: string, edit = false) {
    const doc = this.catalog.get<DocumentRecord>('document', id);
    requireValue(doc, 'NOT_FOUND', 'Документ не найден.', 404);
    if (doc.conversation)
      requireValue(
        doc.owner === user.id,
        'FORBIDDEN',
        'Документ доступен только владельцу диалога.',
        403,
      );
    else this.collection(user, doc.collection, edit || doc.state === 'draft');
    return doc;
  }
  async create(
    login: string,
    password: string,
    role: User['role'],
    options: { groups?: string[]; blocked?: boolean } = {},
    validate?: () => void,
  ) {
    requireValue(/^[\p{L}\p{N}_.@-]{2,80}$/u.test(login), 'INVALID_LOGIN', 'Некорректный логин.');
    requireValue(['user', 'editor', 'admin'].includes(role), 'INVALID_ROLE', 'Некорректная роль.');
    requireValue(
      this.catalog.count('user', 'name=?', [login]) === 0,
      'LOGIN_EXISTS',
      'Логин уже существует.',
      409,
    );
    const user: User = {
      id: randomUUID(),
      login,
      password: await passwordHash(password),
      role,
      blocked: options.blocked ?? false,
      groups: options.groups ?? [],
      revision: 1,
    };
    // Re-check after async password derivation, before the single writer commits.
    requireValue(
      this.catalog.count('user', 'name=?', [login]) === 0,
      'LOGIN_EXISTS',
      'Логин уже существует.',
      409,
    );
    for (const id of user.groups)
      requireValue(this.catalog.get('group', id), 'INVALID_GROUP', 'Группа не найдена.');
    validate?.();
    this.catalog.put('user', user);
    return publicUser(user);
  }
}
