import { Pool } from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';
import { requestContext } from '../../application/request-context.js';
import { requireValue } from '../../shared/errors.js';
import { resourceTables, schemaSQL, schemaSignature } from './postgres-schema.js';
import type { ResourceTable } from './postgres-schema.js';

export const tableName = (kind: ResourceTable) =>
  kind === 'group' ? 'groups' : kind === 'check_question' ? 'check_questions' : kind + 's';
export class Database {
  readonly pool: Pool;
  constructor(url: string) {
    this.pool = new Pool({
      connectionString: url,
      max: 8,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
    });
    this.pool.on('error', () => console.error('PostgreSQL idle connection failed'));
  }
  async initialize(adminUrl: string) {
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock(708124153)');
        const existing = await c.query<{ exists: string | null }>(
          "SELECT to_regclass('public.app_format')::text AS exists",
        );
        if (existing.rows[0]?.exists) {
          const result = await c.query<{ signature: string }>('SELECT signature FROM app_format');
          requireValue(
            result.rows[0]?.signature === schemaSignature,
            'SCHEMA_INCOMPATIBLE',
            'Incompatible database. Create a new empty development database; automatic conversion is not supported.',
            409,
          );
        } else {
          await c.query(schemaSQL);
          await c.query('INSERT INTO app_format VALUES($1)', [schemaSignature]);
        }
        const app = new URL(this.pool.options.connectionString!);
        const role = decodeURIComponent(app.username),
          password = decodeURIComponent(app.password);
        requireValue(
          /^[a-z_][a-z0-9_]*$/u.test(role) && !['postgres'].includes(role),
          'INVALID_CONFIG',
          'Use a separate non-owner DATABASE_URL role.',
        );
        const exists = await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
        if (!exists.rowCount)
          await c.query(
            `CREATE ROLE "${role}" LOGIN PASSWORD '${password.replaceAll("'", "''")}' NOSUPERUSER NOBYPASSRLS`,
          );
        await c.query(
          `GRANT CONNECT,CREATE ON DATABASE "${app.pathname.slice(1).replaceAll('"', '""')}" TO "${role}"`,
        );
        await c.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
        await c.query(
          `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`,
        );
        await c.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
        await c.query(`CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION "${role}"`);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    } finally {
      await admin.end();
    }
    await this.verify();
  }
  async verify() {
    const role = await this.pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
    );
    requireValue(
      role.rows[0] && !role.rows[0].rolsuper && !role.rows[0].rolbypassrls,
      'UNSAFE_DATABASE_ROLE',
      'Application role must not bypass row security.',
    );
    const result = await this.pool.query<{ signature: string }>('SELECT signature FROM app_format');
    requireValue(
      result.rows[0]?.signature === schemaSignature,
      'SCHEMA_INCOMPATIBLE',
      'Database format does not match this release.',
      409,
    );
  }
  async query<T extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    const context = requestContext.getStore();
    if (context?.transaction) return (await context.transaction.query<T>(sql, values)).rows;
    if (context?.tenant) return this.transaction(() => this.query<T>(sql, values));
    return (await this.pool.query<T>(sql, values)).rows;
  }
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    const context = requestContext.getStore() ?? { tenant: '', user: '' };
    if (context.transaction) return work();
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('rag.tenant',$1,true)", [context.tenant]);
      const result = await requestContext.run({ ...context, transaction: c }, work);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async tenant<T>(tenant: string, user: string, work: () => Promise<T>): Promise<T> {
    const current = requestContext.getStore();
    if (current?.transaction) {
      await current.transaction.query("SELECT set_config('rag.tenant',$1,true)", [tenant]);
      try {
        return await requestContext.run({ ...current, tenant, user }, work);
      } finally {
        await current.transaction.query("SELECT set_config('rag.tenant',$1,true)", [
          current.tenant,
        ]);
      }
    }
    return requestContext.run({ tenant, user }, work);
  }
  async lock(scope = 'tenant') {
    const tenant = requestContext.getStore()?.tenant ?? '';
    await this.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      scope + ':' + tenant,
    ]);
  }
  async get<T>(kind: ResourceTable, id: string): Promise<T | undefined> {
    requireValue(resourceTables.includes(kind), 'INVALID_RESOURCE', 'Invalid resource kind.');
    requireValue(
      /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(id),
      'INVALID_ID',
      'Invalid resource identifier.',
    );
    const rows = await this.query<{ body: T }>(
      `SELECT body FROM ${tableName(kind)} WHERE id=$1 AND tenant_id=$2`,
      [id, this.tenantId],
    );
    return rows[0]?.body;
  }
  async list<T>(
    kind: ResourceTable,
    where = 'true',
    values: unknown[] = [],
    limit = 100,
    offset = 0,
  ): Promise<T[]> {
    requireValue(resourceTables.includes(kind), 'INVALID_RESOURCE', 'Invalid resource kind.');
    const rows = await this.query<{ body: T }>(
      `SELECT body FROM ${tableName(kind)} WHERE tenant_id=$1 AND (${where}) ORDER BY coalesce(body->>'created',body->>'updated','') DESC,id LIMIT $${values.length + 2} OFFSET $${values.length + 3}`,
      [this.tenantId, ...values, limit, offset],
    );
    return rows.map((r) => r.body);
  }
  async count(kind: ResourceTable, where = 'true', values: unknown[] = []) {
    const rows = await this.query<{ count: string }>(
      `SELECT count(*) FROM ${tableName(kind)} WHERE tenant_id=$1 AND (${where})`,
      [this.tenantId, ...values],
    );
    return Number(rows[0]?.count ?? 0);
  }
  async put<T extends { id: string }>(kind: ResourceTable, body: T) {
    await this.query(
      `INSERT INTO ${tableName(kind)}(tenant_id,id,body) VALUES($1,$2,$3) ON CONFLICT(tenant_id,id) DO UPDATE SET body=excluded.body`,
      [this.tenantId, body.id, JSON.stringify(body)],
    );
    return body;
  }
  async remove(kind: ResourceTable, id: string) {
    await this.query(`DELETE FROM ${tableName(kind)} WHERE tenant_id=$1 AND id=$2`, [
      this.tenantId,
      id,
    ]);
  }
  get tenantId() {
    const tenant = requestContext.getStore()?.tenant;
    requireValue(tenant, 'TENANT_REQUIRED', 'Select a company.', 400);
    return tenant;
  }
  get userId() {
    return requestContext.getStore()?.user ?? '';
  }
  get client(): PoolClient {
    const client = requestContext.getStore()?.transaction;
    requireValue(client, 'TRANSACTION_REQUIRED', 'A database transaction is required.');
    return client;
  }
  async invalidate(access = false) {
    await this.query(
      `UPDATE tenants SET content_revision=content_revision+1${access ? ',access_revision=access_revision+1' : ''} WHERE id=$1`,
      [this.tenantId],
    );
  }
  async close() {
    await this.pool.end();
  }
}
