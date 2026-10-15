import { randomUUID } from 'node:crypto';
import { authorized, type ActionMap } from '../../application/action-registry.js';
import type { DataContext } from '../../application/data-context.js';
import type { RuntimeState } from '../../application/runtime-state.js';
import type { Job, Principal, Settings, Turn } from '../../domain/entities.js';
import { terminal } from '../../domain/entities.js';
import { requireValue } from '../../shared/errors.js';
import type { Input } from '../../shared/input.js';
import { string } from '../../shared/input.js';
import type { AccessPolicy } from '../identity/access-policy.js';

export class JobService {
  constructor(
    private readonly data: DataContext,
    private readonly access: AccessPolicy,
    private readonly state: RuntimeState,
  ) {}
  readonly actions: ActionMap = {
    'jobs.read': authorized((user, p) => this.handleJobsRead(user, p)),
    'jobs.cancel': authorized((user, p) => this.handleJobsCancel(user, p)),
  };
  create(user: Principal, kind: Job['kind'], payload: Input) {
    this.data.capacity();
    const j: Job = {
      id: randomUUID(),
      owner: user.id,
      kind,
      status: 'queued',
      created: Date.now(),
      updated: Date.now(),
      payload,
      result: {},
      error: '',
      diagnostic: '',
      settings: this.configuration(),
    };
    this.data.catalog.put('job', j);
    this.emit(j);
    return j;
  }

  emit(job: Job) {
    const limit = this.data.catalog.get<Settings>('system', 'settings')?.eventLimit ?? 256;
    this.data.catalog
      .prepare('INSERT INTO events(job,created,body) VALUES (?,?,?)')
      .run(job.id, Date.now(), JSON.stringify({ status: job.status, updated: job.updated }));
    this.data.catalog
      .prepare(
        'DELETE FROM events WHERE job=? AND seq NOT IN (SELECT seq FROM events WHERE job=? ORDER BY seq DESC LIMIT ?)',
      )
      .run(job.id, job.id, limit);
  }

  configuration() {
    return JSON.stringify({
      settings: this.data.catalog.settings(),
      runtime: this.data.models.configuration?.() ?? {},
    });
  }

  update(job: Job, change: Partial<Job>) {
    if (
      job.status === 'queued' &&
      change.status &&
      change.status !== 'queued' &&
      !terminal.has(change.status)
    )
      job.settings = this.configuration();
    Object.assign(job, change, { updated: Date.now() });
    this.data.catalog.put('job', job);
    this.emit(job);
  }

  read(user: Principal, id: string) {
    const j = this.data.catalog.get<Job>('job', id);
    let documentEditor = false;
    if (j?.kind === 'document')
      try {
        this.data.auth.document(user, string(j.payload, 'document'), true);
        documentEditor = true;
      } catch {
        documentEditor = false;
      }
    requireValue(
      j && (j.owner === user.id || user.role === 'admin' || documentEditor),
      'NOT_FOUND',
      'Задание не найдено.',
      404,
    );
    if (j.kind === 'document') this.data.auth.document(user, string(j.payload, 'document'));
    if (j.kind === 'answer') {
      requireValue(
        j.owner === user.id,
        'FORBIDDEN',
        'Диалог доступен только владельцу. Для эксплуатации используйте список заданий.',
        403,
      );
      const t = this.data.catalog.get<Turn>('turn', string(j.payload, 'turn'));
      requireValue(
        t && [...t.sources, ...(t.accessSources ?? [])].every((s) => this.access.source(user, s)),
        'ACCESS_REVOKED',
        'Доступ к источникам отозван.',
        403,
      );
    }
    if (j.kind === 'evaluation') this.data.auth.admin(user);
    return user.role === 'admin' ? j : { ...j, settings: '' };
  }

  cancel(user: Principal, id: string) {
    const stored = this.data.catalog.get<Job>('job', id);
    const j =
      stored && (stored.owner === user.id || user.role === 'admin') ? stored : this.read(user, id);
    requireValue(j, 'NOT_FOUND', 'Задание не найдено.', 404);
    if (!terminal.has(j.status)) {
      this.state.active.get(id)?.abort();
      this.update(j, { status: 'cancelled' });
      if (j.kind === 'answer') {
        const t = this.data.catalog.get<Turn>('turn', string(j.payload, 'turn'));
        if (t) {
          t.status = 'cancelled';
          this.data.catalog.put('turn', t);
        }
      }
    }
    return { ...j, payload: j.owner === user.id ? j.payload : {}, result: {}, settings: '' };
  }

  async handleJobsRead(user: Principal, p: Input) {
    return this.read(user, string(p, 'id'));
  }

  async handleJobsCancel(user: Principal, p: Input) {
    return this.cancel(user, string(p, 'id'));
  }
}
