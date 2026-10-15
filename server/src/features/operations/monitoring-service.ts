import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { authorized, type ActionMap } from '../../application/action-registry.js';
import type { DataContext } from '../../application/data-context.js';
import type { RuntimeState } from '../../application/runtime-state.js';
import type { Job, Principal } from '../../domain/entities.js';
import { extractionHealth } from '../../infrastructure/extraction/health.js';
import type { BackupService } from '../backup/backup-service.js';

export class MonitoringService {
  constructor(
    private readonly data: DataContext,
    private readonly state: RuntimeState,
    private readonly backup: BackupService,
  ) {}
  readonly actions: ActionMap = {
    diagnostics: authorized((user) => this.handleDiagnostics(user)),
    operations: authorized((user) => this.handleOperations(user)),
  };
  async diagnostics() {
    const [dependencies, extraction] = await Promise.all([
      this.data.models.health(this.data.catalog.settings().model),
      extractionHealth(this.data.catalog.settings().ocrLanguage),
    ]);
    const signature = dependencies.indexSignature;
    let writable = true;
    try {
      const probe = join(this.data.catalog.directory, '.write-probe');
      writeFileSync(probe, '', { mode: 0o600 });
      rmSync(probe);
    } catch {
      writable = false;
    }
    return {
      dependencies,
      extraction,
      indexCompatible: !this.data.catalog
        .prepare(
          "SELECT 1 FROM entities d LEFT JOIN entities v ON v.kind='version' AND v.id=d.active_version AND v.document=d.id WHERE d.kind='document' AND d.state='published' AND (v.id IS NULL OR v.state!='ready' OR v.signature<>?) LIMIT 1",
        )
        .get(String(signature ?? '')),
      directoryWritable: writable,
      freeBytes: this.data.freeSpace(),
      sqliteIntegrity: String(
        this.data.catalog.prepare('PRAGMA integrity_check').get()?.integrity_check ?? 'unknown',
      ),
      ready: this.data.readiness().ready,
      hardware: {
        cpu: cpus()[0]?.model ?? 'Unknown',
        cores: cpus().length,
        totalMemory: totalmem(),
        freeMemory: freemem(),
      },
      dataDir: this.data.catalog.directory,
    };
  }

  operations() {
    const running = this.data.catalog.find<Job>(
      'job',
      "state IN ('extracting','ocr','indexing','searching','generating')",
      [],
      'created',
      100,
    );
    const queues = this.data.catalog
      .prepare(
        "SELECT job_kind AS kind,count(*) AS length,min(created) AS oldest FROM entities WHERE kind='job' AND state='queued' GROUP BY job_kind",
      )
      .all();
    const now = Date.now(),
      lanes = queues.map((row) => ({
        kind: String(row.kind),
        length: Number(row.length),
        oldestAgeMs: now - Number(row.oldest),
      }));
    const stats = this.data.catalog
      .prepare(
        "SELECT count(*) AS total,avg(updated-created) AS mean,sum(state='failed') AS errors FROM entities WHERE kind='job' AND job_kind='answer' AND state IN ('complete','failed','no_info','clarification') AND updated>=?",
      )
      .get(now - 86400_000)!;
    const counts = Object.fromEntries(
      this.data.catalog
        .prepare(
          "SELECT kind,count(*) AS n FROM entities WHERE kind IN ('user','document','conversation','collection') GROUP BY kind",
        )
        .all()
        .map((row) => [String(row.kind), Number(row.n)]),
    );
    return {
      sse: this.state.transport,
      cpu: { load: loadavg(), cores: cpus().length, process: process.cpuUsage() },
      memory: { total: totalmem(), free: freemem(), process: process.memoryUsage() },
      freeBytes: this.data.freeSpace(),
      queue: {
        length: lanes.reduce((total, lane) => total + lane.length, 0),
        oldestAgeMs: Math.max(0, ...lanes.map((lane) => lane.oldestAgeMs)),
        lanes,
      },
      running,
      counts: {
        users: counts.user ?? 0,
        documents: counts.document ?? 0,
        conversations: counts.conversation ?? 0,
        collections: counts.collection ?? 0,
      },
      response: {
        meanMs: Number(stats.mean ?? 0),
        errorRate: Number(stats.total) ? Number(stats.errors ?? 0) / Number(stats.total) : 0,
        samples: Number(stats.total),
        windowHours: 24,
      },
      dataBytes: [
        this.data.catalog.path,
        this.data.catalog.path + '-wal',
        this.data.catalog.path + '-shm',
      ].reduce((total, path) => total + (existsSync(path) ? statSync(path).size : 0), 0),
      cacheBytes: Number(
        this.data.catalog.prepare('SELECT COALESCE(sum(bytes),0) AS bytes FROM cache').get()?.bytes,
      ),
      events: Number(this.data.catalog.prepare('SELECT count(*) AS n FROM events').get()?.n),
      backups: this.backup.list(),
      settings: this.data.catalog.settings(),
      maintenance: this.state.maintaining,
    };
  }

  async handleDiagnostics(user: Principal) {
    this.data.auth.admin(user);
    return this.diagnostics();
  }

  async handleOperations(user: Principal) {
    this.data.auth.admin(user);
    return this.operations();
  }
}
