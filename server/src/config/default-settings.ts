import { join } from 'node:path';
import type { Settings } from '../domain/entities.js';
export function defaults(dataDir: string, model: string, prompt: string): Settings {
  return {
    dataDir,
    backupDir: join(dataDir, 'backups'),
    maxBytes: 25 * 1024 * 1024,
    maxPages: 200,
    maxTextCharacters: 8_000_000,
    maxChunks: 20_000,
    maxDocuments: 10000,
    maxQueue: 100,
    minFreeBytes: 100 * 1024 * 1024,
    sessionHours: 24,
    historyDays: 365,
    jobDays: 30,
    tempHours: 24,
    logDays: 30,
    eventLimit: 256,
    backupDays: 30,
    backupIntervalHours: 0,
    nextBackup: 0,
    pauseIndexing: false,
    pauseQueue: false,
    pauseIntake: false,
    topK: 5,
    revision: 1,
    model,
    prompt,
    ocrLanguage: 'eng',
    ocrTimeoutSeconds: 60,
    ocrMemoryMB: 1024,
  };
}
