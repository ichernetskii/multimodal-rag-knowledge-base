import { serverPath } from '../config/paths.js';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Application } from '../application/application.js';
import { defaults } from '../config/default-settings.js';
import { bindDeployment, loadRuntimeConfig, type RuntimeConfig } from '../config/runtime-config.js';
import { integer } from '../config/app-config.js';
import { Catalog } from '../infrastructure/database/catalog.js';
import { LocalModelRuntime } from '../infrastructure/models/local-models.js';
import { createHttpServer } from '../interfaces/http/server.js';
export async function serveApplication() {
  const current = loadRuntimeConfig(),
    port = integer(process.env, 'RAG_PORT', 3210, 1, 65535);
  let directory = serverPath(process.env.RAG_DATA_DIR ?? 'data');
  const location = join(directory, 'data-location.json');
  if (existsSync(location)) {
    const saved = JSON.parse(readFileSync(location, 'utf8')) as { directory: string };
    directory = resolve(saved.directory);
  }
  const catalog = new Catalog(directory);
  const saved = catalog.get<{ runtime: RuntimeConfig }>('system', 'runtime');
  const config =
    process.env.RAG_USE_SAVED_CONFIG === '0' || !saved
      ? current
      : bindDeployment(saved.runtime, current);
  const initial = defaults(directory, config.llm.model, config.app.context.systemPrompt);
  if (process.env.RAG_BACKUP_DIR) initial.backupDir = serverPath(process.env.RAG_BACKUP_DIR);
  const service = new Application(catalog, new LocalModelRuntime(config), initial);
  if (process.env.RAG_BACKUP_DIR && service.initialized) {
    const settings = catalog.settings();
    settings.backupDir = initial.backupDir;
    catalog.setSettings(settings);
  }
  const keyPath = join(directory, 'recovery.key');
  if (!existsSync(keyPath))
    writeFileSync(keyPath, randomBytes(32).toString('base64url'), { mode: 0o600 });
  const server = createHttpServer(service, {
    recoveryKey: readFileSync(keyPath, 'utf8').trim(),
  });
  service.start();
  const host = process.env.RAG_HOST ?? '127.0.0.1';
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    server.closeAllConnections();
    server.close();
    await service.close();
    throw error;
  }
  console.log(`Local RAG: http://${host}:${port} · ${directory}`);
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.closeAllConnections();
    server.close();
    void service
      .close()
      .then(() => {
        process.exitCode = 0;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  server.once('close', () => {
    process.off('SIGINT', close);
    process.off('SIGTERM', close);
  });
  return { server, service };
}
