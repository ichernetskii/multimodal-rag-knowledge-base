import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { authorized, type ActionMap } from '../../application/action-registry.js';
import type { DataContext } from '../../application/data-context.js';
import type { RuntimeState } from '../../application/runtime-state.js';
import type { Job, Principal, Turn } from '../../domain/entities.js';
import { Catalog } from '../../infrastructure/database/catalog.js';
import { assertCurrentSchema } from '../../infrastructure/database/schema.js';
import { verifyBackupFile } from '../../infrastructure/database/backup-verifier.js';
import { requireValue } from '../../shared/errors.js';
import type { Input } from '../../shared/input.js';
import { string } from '../../shared/input.js';
import type { JobService } from '../jobs/job-service.js';

export class BackupService {
  constructor(
    private readonly data: DataContext,
    private readonly state: RuntimeState,
    private readonly jobs: JobService,
  ) {}
  readonly actions: ActionMap = {
    'backup.list': authorized((user) => this.handleBackupList(user)),
    'backup.create': authorized((user) => this.handleBackupCreate(user)),
    'backup.verify': authorized((user, p) => this.handleBackupVerify(user, p)),
    'backup.restore': authorized((user, p) => this.handleBackupRestore(user, p)),
  };
  list() {
    const dir = this.data.catalog.settings().backupDir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return readdirSync(dir)
      .filter((name) => /^backup-[\d-]+\.sqlite$/u.test(name))
      .map((id) => {
        const path = join(dir, id);
        return {
          id,
          bytes: statSync(path).size,
          created: statSync(path).mtimeMs,
          verified: existsSync(path + '.sha256'),
        };
      })
      .sort((a, b) => b.created - a.created);
  }

  async create() {
    requireValue(
      !this.state.backupRunning && !this.state.maintaining,
      'BACKUP_BUSY',
      'Резервное копирование или восстановление уже выполняется.',
      409,
    );
    this.state.backupRunning = true;
    try {
      const dir = this.data.catalog.settings().backupDir;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const id = 'backup-' + Date.now() + '-' + Math.floor(Math.random() * 1000000) + '.sqlite';
      const path = join(dir, id);
      const temporary = path + '.partial';
      let digest: string;
      try {
        digest = await this.data.catalog.snapshot(temporary);
        writeFileSync(temporary + '.sha256', digest, { mode: 0o600 });
        await verifyBackupFile(temporary);
        renameSync(temporary, path);
        renameSync(temporary + '.sha256', path + '.sha256');
      } finally {
        rmSync(temporary, { force: true });
        rmSync(temporary + '.sha256', { force: true });
      }
      for (const old of this.list())
        if (old.created < Date.now() - this.data.catalog.settings().backupDays * 86400_000) {
          rmSync(join(dir, old.id));
          rmSync(join(dir, old.id + '.sha256'), { force: true });
        }
      return { id, sha256: digest, verified: true };
    } finally {
      this.state.backupRunning = false;
    }
  }

  async verify(id: string) {
    requireValue(
      /^backup-[\d-]+\.sqlite$/u.test(id),
      'INVALID_BACKUP',
      'Некорректный идентификатор копии.',
    );
    const path = join(this.data.catalog.settings().backupDir, id);
    return { id, ...(await verifyBackupFile(path)) };
  }

  async restore(id: string, beforeWrite?: () => void) {
    await this.verify(id);
    beforeWrite?.();
    requireValue(
      !this.state.maintaining && !this.state.backupRunning && !this.state.shuttingDown,
      'MAINTENANCE_BUSY',
      'Уже выполняется обслуживание.',
      409,
    );
    this.state.maintaining = true;
    for (const reader of this.state.readers) reader.abort(new Error('MAINTENANCE'));
    const started = Date.now();
    const settings = this.data.catalog.settings();
    const source = join(settings.backupDir, id);
    const rollback = join(this.data.catalog.directory, 'restore-rollback.sqlite');
    try {
      await Promise.allSettled([...this.state.inflight]);
      for (const controller of this.state.active.values()) controller.abort();
      while (this.state.active.size) await new Promise<void>((r) => setTimeout(r, 20));
      await this.data.catalog.snapshot(rollback);
      this.data.catalog.closeConnection();
      const from = new DatabaseSync(source, { readOnly: true });
      try {
        await backup(from, this.data.catalog.path);
      } finally {
        from.close();
      }
      // Reopen connection after atomic SQLite restoration; requests are blocked by server maintenance gate.
      this.data.catalog.replaceConnection(new DatabaseSync(this.data.catalog.path));
      assertCurrentSchema(this.data.catalog.db);
      this.data.catalog.db.exec(
        'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
      );
      const restored = this.data.catalog.settings();
      restored.dataDir = this.data.catalog.directory;
      restored.backupDir = settings.backupDir;
      this.data.catalog.setSettings(restored);
      this.data.catalog.db.exec('DELETE FROM sessions');
      await this.data.models.restoreConfiguration?.(
        this.data.catalog.get<Record<string, unknown>>('system', 'runtime') ?? {},
      );
      for (const j of this.data.catalog.find<Job>(
        'job',
        "state IN ('queued','extracting','ocr','indexing','searching','generating')",
      )) {
        this.jobs.update(j, { status: 'interrupted', error: 'RESTORED_UNFINISHED' });
        if (j.kind === 'answer') {
          const t = this.data.catalog.get<Turn>('turn', string(j.payload, 'turn'));
          if (t) {
            t.status = 'interrupted';
            this.data.catalog.put('turn', t);
          }
        }
      }
      const report = {
        backup: id,
        milliseconds: Date.now() - started,
        restored: this.data.catalog
          .prepare('SELECT kind,count(*) AS count FROM entities GROUP BY kind')
          .all(),
        sessionsRevoked: true,
        completedJobsPreserved: true,
      };
      this.data.catalog.put('system', { ...report, id: 'lastRestore' });
      return report;
    } catch (error) {
      if (existsSync(rollback)) {
        this.data.catalog.closeConnection();
        const from = new DatabaseSync(rollback, { readOnly: true });
        try {
          await backup(from, this.data.catalog.path);
        } finally {
          from.close();
        }
        this.data.catalog.replaceConnection(new DatabaseSync(this.data.catalog.path));
        this.data.catalog.db.exec('PRAGMA journal_mode=WAL;');
        await this.data.models.restoreConfiguration?.(
          this.data.catalog.get<Record<string, unknown>>('system', 'runtime') ?? {},
        );
      }
      throw error;
    } finally {
      this.state.maintaining = false;
    }
  }

  async handleBackupList(user: Principal) {
    this.data.auth.admin(user);
    return this.list();
  }

  async handleBackupCreate(user: Principal) {
    this.data.auth.admin(user);
    return this.create();
  }

  async handleBackupVerify(user: Principal, p: Input) {
    this.data.auth.admin(user);
    return this.verify(string(p, 'id'));
  }

  async handleBackupRestore(user: Principal, p: Input) {
    this.data.auth.admin(user);
    return this.restore(string(p, 'id'), () =>
      this.data.auth.admin(this.data.auth.current(user.id)),
    );
  }
}
/** Exclusive offline restore for another installation; completed work never requeues. */
export async function restoreInstallation(source: string, directory: string) {
  await verifyBackupFile(source);
  const catalog = new Catalog(resolve(directory));
  const started = Date.now();
  const rollback = join(catalog.directory, 'restore-rollback.sqlite');
  await catalog.snapshot(rollback);
  try {
    catalog.closeConnection();
    const from = new DatabaseSync(source, { readOnly: true });
    try {
      requireValue(
        from.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok',
        'BACKUP_CORRUPT',
        'SQLite повреждена.',
      );
      assertCurrentSchema(from);
      await backup(from, catalog.path);
    } finally {
      from.close();
    }
    catalog.replaceConnection(new DatabaseSync(catalog.path));
    assertCurrentSchema(catalog.db);
    const settings = catalog.settings();
    settings.dataDir = catalog.directory;
    settings.backupDir = join(catalog.directory, 'backups');
    catalog.setSettings(settings);
    catalog.db.exec('DELETE FROM sessions');
    for (const j of catalog.find<Job>(
      'job',
      "state IN ('queued','extracting','ocr','indexing','searching','generating')",
    )) {
      j.status = 'interrupted';
      j.error = 'RESTORED_UNFINISHED';
      catalog.put('job', j);
    }
    for (const t of catalog.find<Turn>('turn', "state IN ('queued','searching','generating')")) {
      t.status = 'interrupted';
      catalog.put('turn', t);
    }
    return {
      milliseconds: Date.now() - started,
      restored: catalog.prepare('SELECT kind,count(*) AS count FROM entities GROUP BY kind').all(),
    };
  } catch (error) {
    catalog.closeConnection();
    renameSync(catalog.path, catalog.path + '.failed');
    const from = new DatabaseSync(rollback, { readOnly: true });
    try {
      await backup(from, catalog.path);
    } finally {
      from.close();
    }
    catalog.replaceConnection(new DatabaseSync(catalog.path));
    throw error;
  } finally {
    catalog.close();
  }
}
