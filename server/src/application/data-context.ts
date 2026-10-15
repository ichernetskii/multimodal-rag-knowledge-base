import { statfsSync } from 'node:fs';
import type { Settings } from '../domain/entities.js';
import { Auth } from '../features/identity/auth-service.js';
import type { Catalog } from '../infrastructure/database/catalog.js';
import { requireValue } from '../shared/errors.js';
import type { ModelRuntime } from './ports/model-runtime.js';
import type { RuntimeState } from './runtime-state.js';
export class DataContext {
  auth: Auth;
  constructor(
    public catalog: Catalog,
    readonly models: ModelRuntime,
    readonly initialSettings: Settings,
    private readonly state: RuntimeState,
  ) {
    this.auth = new Auth(catalog);
  }
  get initialized() {
    return this.catalog.count('user') > 0;
  }
  readiness() {
    if (!this.initialized) return { ready: false, reason: 'SETUP_REQUIRED' };
    const s = this.catalog.settings();
    const reason = this.state.maintaining
      ? 'MAINTENANCE'
      : s.pauseIntake
        ? 'INTAKE_PAUSED'
        : this.freeSpace() < s.minFreeBytes
          ? 'DISK_FULL'
          : this.catalog.count(
                'job',
                "state IN ('queued','extracting','ocr','indexing','searching','generating')",
              ) >= s.maxQueue
            ? 'QUEUE_FULL'
            : '';
    return { ready: !reason, reason };
  }
  freeSpace() {
    const s = statfsSync(this.catalog.directory);
    return Number(s.bavail) * Number(s.bsize);
  }
  capacity() {
    const s = this.catalog.settings();
    requireValue(
      this.freeSpace() >= s.minFreeBytes,
      'DISK_FULL',
      'Недостаточно свободного места.',
      507,
    );
    requireValue(!s.pauseIntake, 'INTAKE_PAUSED', 'Приём новых заданий приостановлен.', 503);
    requireValue(
      this.catalog.count(
        'job',
        "state IN ('queued','extracting','ocr','indexing','searching','generating')",
      ) < s.maxQueue,
      'QUEUE_FULL',
      'Очередь заполнена.',
      429,
    );
  }
}
