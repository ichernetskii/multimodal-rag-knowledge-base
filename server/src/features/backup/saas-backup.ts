import { randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Services } from '../../application/services.js';
import type { Job, Principal, BackupRecord, Settings } from '../../contracts/public.js';
import { schemaSignature, resourceTables } from '../../infrastructure/database/postgres-schema.js';
import { tableName } from '../../infrastructure/database/postgres.js';
import { requireValue } from '../../shared/errors.js';
import type { Asset } from '../../domain/entities.js';
interface Backup extends BackupRecord {
  state: 'building' | 'ready' | 'failed';
  manifest: string;
  sha256: string;
  error?: string;
}
interface Part {
  table: string;
  key: string;
  sha256: string;
  bytes: number;
  rows: number;
}
interface Manifest {
  format: string;
  tenant: string;
  id: string;
  created: number;
  tenantData: Record<string, unknown>;
  parts: Part[];
  assets: { key: string; original: string; sha256: string; bytes: number }[];
  mac: string;
}
const backupFormat = schemaSignature + ':tenant-data-v3';
const partLimit = 128 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const tables = [
  ...resourceTables
    .filter((t) => !['backup', 'audit', 'upload', 'model'].includes(t))
    .map(tableName),
  'assets',
  'source_fragments',
  'chunks',
];
const restoreOrder = [
  'invitations',
  'groups',
  'collections',
  'conversations',
  'documents',
  'versions',
  'index_builds',
  'syncs',
  'assets',
  'source_fragments',
  'chunks',
  'turns',
  'jobs',
  'feedbacks',
  'check_questions',
  'evaluations',
];
export class Backups {
  private readonly columnNames = new Map<string, string[]>();
  constructor(readonly s: Services) {}
  private async columns(table: string) {
    const cached = this.columnNames.get(table);
    if (cached) return cached;
    const rows = await this.s.db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position",
      [table],
    );
    const columns = rows.map((row) => row.column_name);
    requireValue(
      columns.length > 0 && columns.every((column) => /^[a-z_][a-z_0-9]*$/u.test(column)),
      'BACKUP_SCHEMA',
      'Backup table columns are unavailable.',
    );
    this.columnNames.set(table, columns);
    return columns;
  }
  private mac(value: Omit<Manifest, 'mac'>) {
    return createHmac('sha256', Buffer.from(this.s.config.encryptionKey, 'hex'))
      .update(JSON.stringify(value))
      .digest('hex');
  }
  async create(user: Principal) {
    this.s.identity.admin(user);
    return this.s.db.transaction(async () => {
      await this.s.db.lock('backup');
      const settings = await this.s.identity.settings();
      const backups = await this.s.db.list<Backup>('backup', 'true', [], 1000);
      requireValue(
        !backups.some((b) => b.state === 'building') && backups.length < 20,
        'BACKUP_LIMIT',
        'Wait for the current backup or expire older copies.',
        429,
      );
      const [size] = await this.s.db.query<{ bytes: string }>(
        'SELECT coalesce(sum(bytes),0) bytes FROM assets WHERE tenant_id=$1',
        [user.tenant],
      );
      requireValue(
        backups.reduce((n, b) => n + b.bytes, 0) + Number(size?.bytes ?? 0) <=
          settings.storageBytes * 3,
        'BACKUP_QUOTA',
        'Backup storage quota exceeded.',
        429,
      );
      const backup: Backup = {
        id: randomUUID(),
        created: Date.now(),
        bytes: 0,
        verified: false,
        state: 'building',
        manifest: '',
        sha256: '',
      };
      await this.s.db.put('backup', backup);
      return this.s.queue.create('maintenance', { operation: 'backup', backup: backup.id }, user);
    });
  }
  async verify(user: Principal, id: string) {
    this.s.identity.admin(user);
    const backup = await this.s.db.get<Backup>('backup', id);
    requireValue(backup?.state === 'ready', 'BACKUP_NOT_READY', 'Backup is not ready.', 409);
    const bytes = await this.s.storage.bytes(backup.manifest, 20 * 1024 * 1024);
    requireValue(
      hash(bytes) === backup.sha256,
      'BACKUP_CORRUPT',
      'Manifest checksum does not match.',
    );
    const manifest = JSON.parse(bytes.toString()) as Manifest;
    requireValue(
      manifest.format === backupFormat && manifest.tenant === user.tenant && manifest.id === id,
      'BACKUP_INCOMPATIBLE',
      'Backup does not match the current format and company.',
    );
    const { mac, ...unsigned } = manifest;
    const expected = Buffer.from(this.mac(unsigned), 'hex'),
      provided = Buffer.from(mac, 'hex');
    requireValue(
      provided.length === expected.length && timingSafeEqual(provided, expected),
      'BACKUP_AUTHENTICITY',
      'Backup authentication failed.',
    );
    for (const part of manifest.parts) {
      requireValue(
        [...tables, 'memberships', 'users'].includes(part.table) &&
          part.key.startsWith(`backups/${user.tenant}/${id}/`),
        'BACKUP_CORRUPT',
        'Invalid snapshot part.',
      );
      const data = await this.s.storage.bytes(part.key, partLimit);
      requireValue(
        data.length === part.bytes && hash(data) === part.sha256,
        'BACKUP_CORRUPT',
        'Snapshot part checksum does not match.',
      );
    }
    for (const asset of manifest.assets) {
      requireValue(
        asset.original.startsWith(`tenants/${user.tenant}/objects/`) &&
          asset.key.startsWith(`backups/${user.tenant}/${id}/`),
        'BACKUP_CORRUPT',
        'Invalid file reference.',
      );
      requireValue(
        (await this.s.storage.digest(asset.key, asset.bytes)) === asset.sha256,
        'BACKUP_CORRUPT',
        'File checksum does not match.',
      );
    }
    return { backup, manifest };
  }
  async process(job: Job, user: Principal, signal: AbortSignal, attempt: string) {
    const id = String(job.payload.backup);
    if (job.payload.operation === 'restore') {
      await this.restore(job, user, id, signal, attempt);
      return;
    }
    const backup = await this.s.db.get<Backup>('backup', id);
    requireValue(backup, 'NOT_FOUND', 'Backup not found.', 404);
    try {
      backup.state = 'building';
      await this.s.db.put('backup', backup);
      await this.s.queue.update(job.id, { status: 'indexing' }, attempt);
      const manifest: Manifest = {
        format: backupFormat,
        tenant: user.tenant,
        id,
        created: backup.created,
        tenantData: {},
        parts: [],
        assets: [],
        mac: '',
      };
      const client = await this.s.db.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SELECT set_config('rag.tenant',$1,true)", [user.tenant]);
        const tenant = await client.query<Record<string, unknown>>(
          'SELECT * FROM tenants WHERE id=$1',
          [user.tenant],
        );
        manifest.tenantData = tenant.rows[0]!;
        for (const table of ['users', 'memberships', ...tables]) {
          const projection = (await this.columns(table))
            .map((column) => '"' + column + '"')
            .join(',');
          const batch =
            table === 'versions'
              ? 1
              : [
                    'turns',
                    'feedbacks',
                    'evaluations',
                    'jobs',
                    'collections',
                    'check_questions',
                  ].includes(table)
                ? 10
                : 250;
          let cursor = '',
            sequence = 0;
          while (true) {
            signal.throwIfAborted();
            const rows =
              table === 'users'
                ? (
                    await client.query<Record<string, unknown>>(
                      'SELECT u.id,u.login,u.password FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.tenant_id=$1 AND u.id::text>$2 ORDER BY u.id LIMIT 250',
                      [user.tenant, cursor],
                    )
                  ).rows
                : table === 'memberships'
                  ? (
                      await client.query<Record<string, unknown>>(
                        `SELECT ${projection} FROM memberships WHERE tenant_id=$1 AND user_id::text>$2 ORDER BY user_id LIMIT 250`,
                        [user.tenant, cursor],
                      )
                    ).rows
                  : (
                      await client.query<Record<string, unknown>>(
                        `SELECT ${projection} FROM ${table} WHERE tenant_id=$1 AND id::text>$2 ORDER BY id LIMIT ${batch}`,
                        [user.tenant, cursor],
                      )
                    ).rows;
            if (!rows.length) break;
            const bytes = Buffer.from(JSON.stringify(rows)),
              key = `backups/${user.tenant}/${id}/tables/${table}-${sequence++}.json`;
            requireValue(
              bytes.length <= partLimit,
              'BACKUP_PART_LIMIT',
              'Snapshot batch exceeds memory limit.',
            );
            await this.s.queue.update(
              job.id,
              { status: 'indexing', result: { stage: table, part: sequence } },
              attempt,
            );
            await this.s.storage.put(key, bytes, 'application/json');
            manifest.parts.push({
              table,
              key,
              sha256: hash(bytes),
              bytes: bytes.length,
              rows: rows.length,
            });
            backup.bytes += bytes.length;
            if (table === 'assets')
              for (const asset of rows as unknown as Asset[]) {
                const key = `backups/${user.tenant}/${id}/assets/${asset.id}`;
                await this.s.storage.copy(asset.object_key, key);
                manifest.assets.push({
                  key,
                  original: asset.object_key,
                  bytes: Number(asset.bytes),
                  sha256: asset.sha256,
                });
                backup.bytes += Number(asset.bytes);
              }
            cursor = String(rows.at(-1)![table === 'memberships' ? 'user_id' : 'id']);
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      const { mac, ...unsigned } = manifest;
      void mac;
      manifest.mac = this.mac(unsigned);
      const bytes = Buffer.from(JSON.stringify(manifest));
      backup.manifest = `backups/${user.tenant}/${id}/manifest.json`;
      backup.sha256 = hash(bytes);
      await this.s.storage.put(backup.manifest, bytes, 'application/json');
      backup.state = 'ready';
      await this.s.db.put('backup', backup);
      await this.verify(user, id);
      backup.verified = true;
      await this.s.db.transaction(async () => {
        await this.s.queue.update(
          job.id,
          { status: 'complete', result: { backup: id, bytes: backup.bytes, verified: true } },
          attempt,
        );
        await this.s.db.put('backup', backup);
        await this.s.identity.audit(user.id, 'backup.create', id);
      });
    } catch (e) {
      backup.state = 'failed';
      backup.error = e instanceof Error ? e.message : 'Backup failed';
      await this.s.db.put('backup', backup);
      throw e;
    }
  }
  async restore(job: Job, user: Principal, id: string, signal: AbortSignal, attempt: string) {
    this.s.identity.admin(user);
    const { manifest } = await this.verify(user, id);
    await this.s.db.query(
      'UPDATE tenants SET maintenance=true,access_revision=access_revision+1 WHERE id=$1',
      [user.tenant],
    );
    try {
      const jobs = await this.s.db.list<Job>(
        'job',
        "body->>'status' NOT IN('complete','no_info','clarification','cancelled','interrupted','failed')",
        [],
        100000,
      );
      for (const j of jobs)
        if (j.id !== job.id) {
          await this.s.db.query('DELETE FROM job_attempts WHERE tenant_id=$1 AND job_id=$2', [
            user.tenant,
            j.id,
          ]);
          await this.s.queue.update(j.id, { status: 'interrupted' });
          await this.s.queue.boss.cancel('rag-' + j.kind, j.id);
        }
      for (const asset of manifest.assets) {
        signal.throwIfAborted();
        await this.s.storage.copy(asset.key, asset.original);
      }
      const storage = this.s.storage;
      const readRows = async function* (table: string) {
        for (const part of manifest.parts.filter((p) => p.table === table)) {
          signal.throwIfAborted();
          const rows = JSON.parse((await storage.bytes(part.key, partLimit)).toString()) as Record<
            string,
            unknown
          >[];
          for (const row of rows) yield row;
        }
      };
      await this.s.db.transaction(async () => {
        await this.s.db.lock('restore');
        await this.s.queue.update(job.id, { status: 'indexing' }, attempt);
        await this.s.db.query(
          'INSERT INTO gc_objects SELECT object_key,$2 FROM assets WHERE tenant_id=$1 ON CONFLICT DO NOTHING',
          [user.tenant, Date.now()],
        );
        await this.s.db.query('DELETE FROM gc_objects WHERE object_key=ANY($1::text[])', [
          manifest.assets.map((a) => a.original),
        ]);
        await this.s.db.query('DELETE FROM idempotency WHERE tenant_id=$1', [user.tenant]);
        await this.s.db.query('DELETE FROM chunks WHERE tenant_id=$1', [user.tenant]);
        await this.s.db.query('DELETE FROM source_fragments WHERE tenant_id=$1', [user.tenant]);
        for (const table of [...restoreOrder].reverse()) {
          if (table === 'jobs')
            await this.s.db.query('DELETE FROM jobs WHERE tenant_id=$1 AND id<>$2', [
              user.tenant,
              job.id,
            ]);
          else await this.s.db.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [user.tenant]);
        }
        await this.s.db.query('DELETE FROM memberships WHERE tenant_id=$1', [user.tenant]);
        for await (const row of readRows('users'))
          await this.s.db.query(
            'INSERT INTO users(id,login,password) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
            [row.id, row.login, row.password],
          );
        const insert = async (table: string, row: Record<string, unknown>) => {
          const allowed = await this.columns(table);
          const columns = Object.keys(row);
          requireValue(
            columns.every((k) => allowed.includes(k)),
            'BACKUP_CORRUPT',
            'Invalid column.',
          );
          const values = columns.map((k) =>
            ['body', 'settings', 'groups', 'result'].includes(k) ? JSON.stringify(row[k]) : row[k],
          );
          await this.s.db.query(
            `INSERT INTO ${table}(${columns.map((k) => '"' + k + '"').join(',')}) VALUES(${columns.map((_, i) => '$' + (i + 1)).join(',')})`,
            values,
          );
        };
        for await (const row of readRows('memberships')) await insert('memberships', row);
        await this.s.db.query(
          "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT DO NOTHING",
          [user.tenant, user.id],
        );
        for (const table of restoreOrder)
          for await (const row of readRows(table)) {
            requireValue(
              row.tenant_id === user.tenant,
              'BACKUP_CORRUPT',
              'Cross-company snapshot row.',
            );
            if (table === 'jobs' && row.id === job.id) continue;
            if (table === 'jobs') {
              const body = row.body as Job;
              if (
                ![
                  'complete',
                  'no_info',
                  'clarification',
                  'cancelled',
                  'failed',
                  'interrupted',
                ].includes(body.status)
              )
                body.status = 'interrupted';
            }
            await insert(table, row);
          }
        const currentSettings = await this.s.identity.settings(),
          restored = {
            ...(manifest.tenantData.settings as Settings),
            revision: currentSettings.revision + 1,
          };
        for (const field of [
          'maxBytes',
          'maxDocuments',
          'maxQueue',
          'storageBytes',
          'monthlyBudgetMicros',
          'answerConcurrency',
          'indexConcurrency',
        ] as const)
          restored[field] = currentSettings[field];
        await this.s.db.query(
          'UPDATE tenants SET settings=$1,content_revision=content_revision+1,access_revision=access_revision+1 WHERE id=$2',
          [JSON.stringify(restored), user.tenant],
        );
        await this.s.queue.update(
          job.id,
          {
            status: 'complete',
            result: { backup: id, restored: true, completedJobsPreserved: true },
          },
          attempt,
        );
        await this.s.identity.audit(user.id, 'backup.restore', id);
      });
    } finally {
      await this.s.db.query('UPDATE tenants SET maintenance=false WHERE id=$1', [user.tenant]);
    }
  }
}
