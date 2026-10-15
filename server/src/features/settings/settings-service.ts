import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { authorized, type ActionMap } from '../../application/action-registry.js';
import type { DataContext } from '../../application/data-context.js';
import type { Principal, Settings } from '../../domain/entities.js';
import { requireValue } from '../../shared/errors.js';
import type { Input } from '../../shared/input.js';
import { number, object, revision, string } from '../../shared/input.js';

export class SettingsService {
  constructor(private readonly data: DataContext) {}
  readonly actions: ActionMap = {
    'settings.read': authorized((user) => this.handleSettingsRead(user)),
    'settings.save': authorized((user, p) => this.handleSettingsSave(user, p)),
  };
  validate(p: Input): Settings {
    requireValue(
      Object.keys(p).every((key) => Object.hasOwn(this.data.initialSettings, key)),
      'INVALID_SETTINGS',
      'Настройки содержат неподдерживаемые поля.',
    );
    const out = { ...this.data.initialSettings };
    for (const key of ['dataDir', 'backupDir', 'model', 'prompt', 'ocrLanguage'] as const)
      out[key] = string(p, key, out[key]);
    requireValue(
      out.model.trim() && out.prompt.trim() && /^[a-z_+]+$/u.test(out.ocrLanguage),
      'INVALID_SETTINGS',
      'Укажите модель, промпт и язык OCR.',
    );
    const bounds: Record<string, [number, number]> = {
      maxBytes: [1024, 100 * 1024 * 1024],
      maxPages: [1, 2000],
      maxTextCharacters: [1000, 32_000_000],
      maxChunks: [1, 50_000],
      maxDocuments: [1, 100000],
      maxQueue: [1, 10000],
      minFreeBytes: [0, 1e12],
      sessionHours: [1, 720],
      historyDays: [1, 36500],
      jobDays: [1, 36500],
      tempHours: [1, 8760],
      logDays: [1, 36500],
      eventLimit: [16, 1024],
      backupDays: [1, 36500],
      backupIntervalHours: [0, 8760],
      topK: [1, 20],
      ocrTimeoutSeconds: [5, 600],
      ocrMemoryMB: [256, 16384],
      revision: [1, 1e9],
      nextBackup: [0, 1e15],
    };
    for (const [key, [min, max]] of Object.entries(bounds)) {
      const v = number(p, key, out[key as keyof Settings] as number);
      requireValue(
        Number.isInteger(v) && v >= min && v <= max,
        'INVALID_SETTINGS',
        `Некорректный лимит ${key}.`,
      );
      Object.assign(out, { [key]: v });
    }
    for (const key of ['pauseIndexing', 'pauseQueue', 'pauseIntake'] as const) {
      const v = p[key] ?? out[key];
      requireValue(typeof v === 'boolean', 'INVALID_SETTINGS', `Некорректное поле ${key}.`);
      out[key] = v;
    }
    out.dataDir = resolve(out.dataDir);
    out.backupDir = resolve(out.backupDir);
    mkdirSync(out.backupDir, { recursive: true, mode: 0o700 });
    return out;
  }

  async handleSettingsRead(user: Principal) {
    this.data.auth.admin(user);
    return this.data.catalog.settings();
  }

  async handleSettingsSave(user: Principal, p: Input) {
    this.data.auth.admin(user);
    const old = this.data.catalog.settings();
    revision(p, old);
    const next = this.validate({
      ...old,
      ...object(p, 'settings'),
      revision: old.revision + 1,
    });
    requireValue(
      next.dataDir === old.dataDir,
      'DATA_DIR_RESTART_REQUIRED',
      'Для смены каталога остановите сервер и восстановите копию в новый каталог.',
    );
    this.data.catalog.setSettings(next);
    return next;
  }
}
