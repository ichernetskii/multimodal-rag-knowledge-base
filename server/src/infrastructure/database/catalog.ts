import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SQLInputValue, StatementSync } from 'node:sqlite';
import { DatabaseSync, backup } from 'node:sqlite';
import type { Settings } from '../../domain/entities.js';
import { AppError } from '../../shared/errors.js';
import { fileHash } from '../files/file-hash.js';
import { assertCurrentSchema, initializeSchema } from './schema.js';

/** One writer, one SQLite snapshot including original bytes. No cross-file backup race. */
export class Catalog {
  private connection: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  private transactionDepth = 0;
  get db() {
    return this.connection;
  }
  replaceConnection(connection: DatabaseSync) {
    this.statements.clear();
    this.connection = connection;
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  }
  prepare(sql: string) {
    let statement = this.statements.get(sql);
    if (statement) {
      this.statements.delete(sql);
      this.statements.set(sql, statement);
      return statement;
    }
    statement = this.db.prepare(sql);
    if (this.statements.size >= 128) this.statements.delete(this.statements.keys().next().value!);
    this.statements.set(sql, statement);
    return statement;
  }
  /** SQL clauses are server-owned; values must be bound, never interpolated from requests. */
  find<T>(
    kind: string,
    where = '1',
    params: SQLInputValue[] = [],
    order = 'id',
    limit = 100_000,
    offset = 0,
  ): T[] {
    return this.prepare(
      `SELECT body FROM entities WHERE kind=? AND (${where}) ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
      .all(kind, ...params, limit, offset)
      .map((row) => JSON.parse(String(row.body)) as T);
  }
  count(kind: string, where = '1', params: SQLInputValue[] = []) {
    return Number(
      this.prepare(`SELECT count(*) AS n FROM entities WHERE kind=? AND (${where})`).get(
        kind,
        ...params,
      )?.n ?? 0,
    );
  }
  readonly path: string;
  private readonly lock: string;
  constructor(
    readonly directory: string,
    lock = true,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'catalog.sqlite');
    this.lock = lock ? join(directory, '.writer-lock') : '';
    if (lock) {
      try {
        mkdirSync(this.lock);
        writeFileSync(join(this.lock, 'pid'), String(process.pid));
      } catch {
        throw new AppError(
          'WRITER_RUNNING',
          'Каталог занят сервером. Используйте API/CLI сервера. После аварии проверьте PID перед удалением .writer-lock.',
          409,
        );
      }
    }
    let opened: DatabaseSync | undefined;
    try {
      if (existsSync(this.path)) {
        const probe = new DatabaseSync(this.path, { readOnly: true });
        try {
          const tables = probe
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .all();
          if (tables.length || Number(probe.prepare('PRAGMA user_version').get()?.user_version))
            assertCurrentSchema(probe);
        } finally {
          probe.close();
        }
      }
      this.connection = opened = new DatabaseSync(this.path);
      chmodSync(this.path, 0o600);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      if (
        !this.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all().length
      )
        initializeSchema(this.db);
      assertCurrentSchema(this.db);
    } catch (error) {
      opened?.close();
      if (this.lock) rmSync(this.lock, { recursive: true, force: true });
      throw error;
    }
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.prepare('SELECT body FROM entities WHERE kind=? AND id=?').get(kind, id);
    return row ? (JSON.parse(String(row.body)) as T) : undefined;
  }
  list<T>(kind: string): T[] {
    return this.prepare('SELECT body FROM entities WHERE kind=? ORDER BY id')
      .all(kind)
      .map((row) => JSON.parse(String(row.body)) as T);
  }
  put<T extends { id: string }>(kind: string, value: T) {
    const record = value as Record<string, unknown>,
      name = record.name ?? record.login ?? record.title,
      question = record.question;
    this.prepare(
      'INSERT INTO entities(kind,id,body,search_name,search_text) VALUES (?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,search_name=excluded.search_name,search_text=excluded.search_text',
    ).run(
      kind,
      value.id,
      JSON.stringify(value),
      typeof name === 'string' ? name.toLowerCase() : '',
      typeof question === 'string' ? question.toLowerCase() : '',
    );
  }
  delete(kind: string, id: string) {
    this.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind, id);
  }
  transaction<T>(fn: () => T): T {
    const depth = this.transactionDepth,
      savepoint = 'rag_' + depth;
    this.db.exec(depth ? 'SAVEPOINT ' + savepoint : 'BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const result = fn();
      this.db.exec(depth ? 'RELEASE ' + savepoint : 'COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec(depth ? 'ROLLBACK TO ' + savepoint + '; RELEASE ' + savepoint : 'ROLLBACK');
      } catch {
        /* SQLite can already have rolled back on a full disk. */
      }
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
  epoch() {
    return this.get<{ id: string; value: number }>('system', 'epoch')?.value ?? 0;
  }
  accessEpoch() {
    return this.get<{ value: number }>('system', 'access_epoch')?.value ?? 0;
  }
  invalidate(access = false) {
    this.transaction(() => {
      if (access) this.put('system', { id: 'access_epoch', value: this.accessEpoch() + 1 });
      this.put('system', { id: 'epoch', value: this.epoch() + 1 } as { id: string });
      this.db.exec('DELETE FROM cache');
    });
  }
  settings(): Settings {
    const value = this.get<Settings & { id: string }>('system', 'settings');
    if (!value) throw new AppError('SETUP_REQUIRED', 'Завершите первоначальную настройку.', 503);
    const settings = { ...value };
    Reflect.deleteProperty(settings, 'id');
    return settings;
  }
  setSettings(value: Settings) {
    this.transaction(() => {
      this.put('system', { ...value, id: 'settings' });
      this.invalidate();
    });
  }
  log(code: string, diagnostic: string) {
    try {
      this.prepare('INSERT INTO logs(created,code,diagnostic) VALUES (?,?,?)').run(
        Date.now(),
        code,
        diagnostic,
      );
    } catch {
      /* SQLite may be full; avoid recursive logging failures. */
    }
  }
  readSnapshot() {
    const db = new DatabaseSync(this.path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=5000; BEGIN;');
    return {
      db,
      close() {
        if (db.isOpen) {
          db.exec('ROLLBACK');
          db.close();
        }
      },
    };
  }
  async snapshot(path: string) {
    await backup(this.db, path);
    chmodSync(path, 0o600);
    const test = new DatabaseSync(path, { readOnly: true });
    try {
      if (test.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
        throw new AppError('BACKUP_CORRUPT', 'Проверка SQLite не пройдена.');
    } finally {
      test.close();
    }
    return fileHash(path);
  }
  closeConnection() {
    this.statements.clear();
    if (this.db.isOpen) this.db.close();
  }
  close() {
    this.closeConnection();
    if (this.lock && existsSync(this.lock)) rmSync(this.lock, { recursive: true, force: true });
  }
}
