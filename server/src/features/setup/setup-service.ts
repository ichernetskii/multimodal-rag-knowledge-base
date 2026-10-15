import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type ActionMap } from '../../application/action-registry.js';
import type { DataContext } from '../../application/data-context.js';
import { Catalog } from '../../infrastructure/database/catalog.js';
import { AppError, requireValue } from '../../shared/errors.js';
import type { Input } from '../../shared/input.js';
import { object, string } from '../../shared/input.js';
import { Auth, passwordHash } from '../identity/auth-service.js';
import type { SettingsService } from '../settings/settings-service.js';

export class SetupService {
  constructor(
    private readonly data: DataContext,
    private readonly settings: SettingsService,
  ) {}
  readonly actions: ActionMap = {
    'setup.status': () => this.status(),
    'setup.create': (p) => this.create(p),
  };
  async status() {
    return {
      initialized: this.data.initialized,
      dataDir: this.data.catalog.directory,
      defaults: this.data.initialized ? null : this.data.initialSettings,
    };
  }

  async create(p: Input) {
    requireValue(
      !this.data.initialized,
      'ALREADY_INITIALIZED',
      'Первоначальная настройка уже выполнена.',
      409,
    );
    const settings = this.settings.validate({
      ...this.data.initialSettings,
      ...object(p, 'settings'),
    });
    const password = await passwordHash(string(p, 'password'));
    requireValue(
      !this.data.initialized,
      'ALREADY_INITIALIZED',
      'Первоначальная настройка уже выполнена.',
      409,
    );
    const login = string(p, 'login');
    requireValue(/^[\p{L}\p{N}_.@-]{2,80}$/u.test(login), 'INVALID_LOGIN', 'Некорректный логин.');
    if (resolve(settings.dataDir) !== resolve(this.data.catalog.directory)) {
      const next = new Catalog(settings.dataDir);
      if (next.count('user')) {
        next.close();
        throw new AppError('DIRECTORY_IN_USE', 'В выбранном каталоге уже есть установка.', 409);
      }
      const previous = this.data.catalog;
      this.data.catalog = next;
      this.data.auth = new Auth(next);
      if (this.data.models.configuration)
        this.data.catalog.put('system', { id: 'runtime', ...this.data.models.configuration() });
      previous.close();
      writeFileSync(join(settings.dataDir, 'recovery.key'), randomBytes(32).toString('base64url'), {
        mode: 0o600,
      });
      writeFileSync(
        join(previous.directory, 'data-location.json'),
        JSON.stringify({ directory: settings.dataDir }),
        { mode: 0o600 },
      );
    }
    this.data.catalog.transaction(() => {
      this.data.catalog.setSettings(settings);
      this.data.catalog.put('user', {
        id: randomUUID(),
        login,
        password,
        role: 'admin',
        blocked: false,
        groups: [],
        revision: 1,
      });
    });
    return { initialized: true };
  }
}
