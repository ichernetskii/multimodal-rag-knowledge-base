import {
  randomBytes,
  randomUUID,
  scrypt as derive,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { Database } from '../../infrastructure/database/postgres.js';
import type { Principal, User, Tenant, Settings, Invitation } from '../../contracts/public.js';
import { defaults, initialProfiles, profileIds } from '../../config/default-settings.js';
import type { DeploymentConfig } from '../../config/saas-config.js';
import { requireValue } from '../../shared/errors.js';
const scrypt = promisify(derive);
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export async function passwordHash(password: string) {
  requireValue(
    password.length >= 12 && password.length <= 1024,
    'PASSWORD_LENGTH',
    'Use a password of 12–1024 characters.',
  );
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return salt + ':' + hash.toString('hex');
}
async function matches(password: string, hash: string) {
  const [salt, value] = hash.split(':');
  if (!salt || !value) return false;
  const expected = Buffer.from(value, 'hex'),
    actual = (await scrypt(password, salt, 64)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export class Identity {
  constructor(
    readonly db: Database,
    private readonly config: DeploymentConfig,
  ) {}
  async initialized() {
    const rows = await this.db.query<{ count: string }>(
      'SELECT count(*) FROM users WHERE operator',
    );
    return Number(rows[0]?.count) > 0;
  }
  async bootstrap(login: string, password: string, name = 'Workspace') {
    const encoded = await passwordHash(password);
    return this.db.transaction(async () => {
      await this.db.query('SELECT pg_advisory_xact_lock(708124154)');
      requireValue(
        !(await this.initialized()),
        'ALREADY_INITIALIZED',
        'An operator already exists.',
        409,
      );
      const id = randomUUID();
      await this.db.query('INSERT INTO users(id,login,password,operator) VALUES($1,$2,$3,true)', [
        id,
        login,
        encoded,
      ]);
      return this.createTenant(id, name);
    });
  }
  async createTenant(user: string, name: string) {
    requireValue(name.trim() && name.length <= 200, 'INVALID_INPUT', 'Company name is required.');
    const id = randomUUID();
    await this.db.query('INSERT INTO tenants(id,name,settings) VALUES($1,$2,$3)', [
      id,
      name.trim(),
      JSON.stringify({
        ...defaults(),
        generationProfile:
          this.config.profileDefaults.generation === 'ollama'
            ? profileIds.ollama
            : this.config.profileDefaults.generation === 'anthropic'
              ? profileIds.anthropic
              : profileIds.generation,
        embeddingProfile:
          this.config.profileDefaults.embedding === 'ollama'
            ? profileIds.localEmbedding
            : profileIds.embedding,
        transcriptionProfile:
          this.config.profileDefaults.transcription === 'whisper'
            ? profileIds.whisper
            : this.config.profileDefaults.transcription === 'google'
              ? profileIds.googleTranscription
              : '',
      }),
    ]);
    await this.db.tenant(id, user, () =>
      this.db.transaction(async () => {
        await this.db.query(
          "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')",
          [id, user],
        );
        for (const profile of initialProfiles(this.config)) await this.db.put('model', profile);
        await this.audit(user, 'tenants.create', id);
      }),
    );
    return { id, name: name.trim(), role: 'admin' as const, blocked: false, revision: 1 };
  }
  async invite(user: Principal, login: string, role: Principal['role']) {
    this.admin(user);
    requireValue(
      login.trim().length > 0 && login.length <= 200 && ['user', 'editor', 'admin'].includes(role),
      'INVALID_INPUT',
      'Login and role are required.',
    );
    const secret = randomBytes(32).toString('base64url');
    const invitation = {
      id: randomUUID(),
      login: login.trim(),
      role,
      created: Date.now(),
      expires: Date.now() + 7 * 86400000,
      used: false,
      hash: digest(secret),
    };
    await this.db.put('invitation', invitation);
    await this.audit(user.id, 'invitations.create', invitation.id);
    const { hash, ...result } = invitation;
    void hash;
    return { ...result, token: user.tenant + '.' + invitation.id + '.' + secret };
  }
  async acceptInvitation(token: string, password: string) {
    const [tenant, id, secret] = token.split('.');
    requireValue(
      tenant && id && secret && /^[a-f\d-]{36}$/iu.test(tenant),
      'INVITATION_INVALID',
      'Invitation is invalid.',
    );
    requireValue(password.length <= 1024, 'PASSWORD_LENGTH', 'Password is too long.');
    const pending = await this.db.tenant(tenant, '', () =>
      this.db.get<Invitation & { hash: string }>('invitation', id),
    );
    requireValue(
      pending && !pending.used && pending.expires > Date.now() && digest(secret) === pending.hash,
      'INVITATION_INVALID',
      'Invitation expired or was revoked.',
    );
    const [limit] = await this.db.query<{ requests: number }>(
      'INSERT INTO rate_windows VALUES($1,$2,1,0) ON CONFLICT(scope,window_start) DO UPDATE SET requests=rate_windows.requests+1 RETURNING requests',
      ['invitation-auth:' + digest(pending.login), Math.floor(Date.now() / 60000)],
    );
    requireValue(Number(limit?.requests) <= 10, 'RATE_LIMIT', 'Too many invitation attempts.', 429);
    return this.db.tenant(tenant, '', () =>
      this.db.transaction(async () => {
        await this.db.lock('invitation');
        const invitation = await this.db.get<Invitation & { hash: string }>('invitation', id);
        requireValue(
          invitation &&
            !invitation.used &&
            invitation.expires > Date.now() &&
            digest(secret) === invitation.hash,
          'INVITATION_INVALID',
          'Invitation expired or was revoked.',
        );
        const [account] = await this.db.query<{ id: string; password: string }>(
          'SELECT id,password FROM users WHERE login=$1',
          [invitation.login],
        );
        let user = account?.id;
        if (account)
          requireValue(
            await matches(password, account.password),
            'AUTH_FAILED',
            'Use the existing account password.',
            401,
          );
        else {
          user = randomUUID();
          await this.db.query('INSERT INTO users(id,login,password) VALUES($1,$2,$3)', [
            user,
            invitation.login,
            await passwordHash(password),
          ]);
        }
        await this.db.query(
          'INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [tenant, user, invitation.role],
        );
        await this.db.put('invitation', { ...invitation, used: true });
        await this.db.invalidate(true);
        return { login: invitation.login };
      }),
    );
  }
  async tenants(user: string) {
    return this.db.query<Tenant & { groups: string[] }>('SELECT * FROM memberships_for_user($1)', [
      user,
    ]);
  }
  async login(login: string, password: string, ip: string) {
    requireValue(
      login.length <= 200 && password.length <= 1024,
      'AUTH_FAILED',
      'Incorrect login or password.',
      401,
    );
    const minute = Math.floor(Date.now() / 60000);
    const rate = await this.db.query<{ requests: number }>(
      `INSERT INTO rate_windows(scope,window_start,requests,tokens) VALUES($1,$2,1,0) ON CONFLICT(scope,window_start) DO UPDATE SET requests=rate_windows.requests+1 RETURNING requests`,
      ['login:' + digest(ip + ':' + login), minute],
    );
    requireValue(
      (rate[0]?.requests ?? 100) > 0 && (rate[0]?.requests ?? 100) <= 10,
      'RATE_LIMIT',
      'Too many login attempts.',
      429,
    );
    const rows = await this.db.query<{ id: string; password: string; blocked: boolean }>(
      'SELECT id,password,blocked FROM users WHERE login=$1',
      [login],
    );
    const user = rows[0];
    const encoded = user?.password ?? '0'.repeat(32) + ':' + '0'.repeat(128);
    requireValue(
      (await matches(password, encoded)) && user && !user.blocked,
      'AUTH_FAILED',
      'Incorrect login or password.',
      401,
    );
    const token = randomBytes(32).toString('base64url');
    await this.db.query('INSERT INTO sessions(id,user_id,created,expires) VALUES($1,$2,$3,$4)', [
      digest(token),
      user.id,
      Date.now(),
      Date.now() + 30 * 86400000,
    ]);
    return { token, user: await this.principal(token) };
  }
  async principal(token: string, tenant?: string): Promise<Principal> {
    requireValue(token, 'UNAUTHENTICATED', 'Sign in.', 401);
    const rows = await this.db.query<{
      id: string;
      login: string;
      operator: boolean;
      blocked: boolean;
    }>(
      'SELECT u.id,u.login,u.operator,u.blocked FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires>$2',
      [digest(token), Date.now()],
    );
    const user = rows[0];
    requireValue(user && !user.blocked, 'UNAUTHENTICATED', 'Session expired or revoked.', 401);
    const principal = await this.current(user.id, tenant);
    const settings = await this.db.tenant(principal.tenant, principal.id, () => this.settings());
    const [session] = await this.db.query<{ created: string }>(
      'SELECT created FROM sessions WHERE id=$1',
      [digest(token)],
    );
    requireValue(
      session && Number(session.created) + settings.sessionHours * 3600000 > Date.now(),
      'UNAUTHENTICATED',
      'Session expired.',
      401,
    );
    return principal;
  }
  async current(id: string, tenant?: string): Promise<Principal> {
    const rows = await this.db.query<{
      id: string;
      login: string;
      operator: boolean;
      blocked: boolean;
    }>('SELECT id,login,operator,blocked FROM users WHERE id=$1', [id]);
    const user = rows[0];
    requireValue(user && !user.blocked, 'UNAUTHENTICATED', 'Account is unavailable.', 401);
    const memberships = await this.tenants(id);
    const selected = tenant
      ? memberships.find((t) => t.id === tenant)
      : memberships.find((t) => !t.blocked);
    requireValue(selected && !selected.blocked, 'TENANT_FORBIDDEN', 'Company is unavailable.', 403);
    return {
      id,
      login: user.login,
      operator: user.operator,
      tenant: selected.id,
      role: selected.role,
      groups: selected.groups,
    };
  }
  admin(user: Principal) {
    requireValue(user.role === 'admin', 'FORBIDDEN', 'Company administrator required.', 403);
  }
  operator(user: Principal) {
    requireValue(user.operator, 'FORBIDDEN', 'Platform operator required.', 403);
  }
  editor(user: Principal) {
    requireValue(
      user.role === 'admin' || user.role === 'editor',
      'FORBIDDEN',
      'Editor permission required.',
      403,
    );
  }
  async settings() {
    const rows = await this.db.query<{ settings: Settings }>(
      'SELECT settings FROM tenants WHERE id=$1',
      [this.db.tenantId],
    );
    requireValue(rows[0], 'NOT_FOUND', 'Company not found.', 404);
    return rows[0].settings;
  }
  async audit(actor: string, action: string, target = '') {
    await this.db.put('audit', { id: randomUUID(), actor, action, target, created: Date.now() });
  }
  async revoke(user: string) {
    await this.db.query('DELETE FROM sessions WHERE user_id=$1', [user]);
  }
  async logout(token: string) {
    await this.db.query('DELETE FROM sessions WHERE id=$1', [digest(token)]);
  }
  async users(query = '', limit = 25, offset = 0) {
    const rows = await this.db.query<{
      id: string;
      login: string;
      role: User['role'];
      blocked: boolean;
      groups: string[];
      revision: number;
    }>(
      `SELECT u.id,u.login,m.role,m.blocked,m.groups,m.revision FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND u.login ILIKE $2 ORDER BY u.login LIMIT $3 OFFSET $4`,
      [this.db.tenantId, '%' + query + '%', limit, offset],
    );
    return rows;
  }
  async createUser(
    login: string,
    password: string,
    role: User['role'],
    groups: string[],
    blocked: boolean,
  ) {
    const encoded = await passwordHash(password);
    return this.db.transaction(async () => {
      const exists = await this.db.query('SELECT 1 FROM users WHERE login=$1', [login]);
      requireValue(
        !exists.length,
        'ACCOUNT_EXISTS',
        'Account already exists. A platform operator can add company membership.',
        409,
      );
      for (const group of groups)
        requireValue(await this.db.get('group', group), 'NOT_FOUND', 'Group not found.', 404);
      const id = randomUUID();
      await this.db.query('INSERT INTO users(id,login,password) VALUES($1,$2,$3)', [
        id,
        login,
        encoded,
      ]);
      await this.db.query(
        'INSERT INTO memberships(tenant_id,user_id,role,groups,blocked) VALUES($1,$2,$3,$4,$5)',
        [this.db.tenantId, id, role, JSON.stringify(groups), blocked],
      );
      await this.db.invalidate(true);
      return { id, login, role, groups, blocked, revision: 1 };
    });
  }
}
