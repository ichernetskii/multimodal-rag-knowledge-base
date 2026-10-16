import { readFile, rm, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ApiClient, credentials, saveCredentials } from './api-client.js';
import { contractSignature } from '../../contracts/format.generated.js';
import type { ActionName, ActionInputs, SyncFolder } from '../../contracts/public.js';
try {
  process.loadEnvFile(fileURLToPath(new URL('../../../../.env', import.meta.url)));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
const args = process.argv.slice(2),
  take = (flag: string) => {
    const i = args.indexOf(flag);
    if (i < 0) return '';
    const result = args[i + 1] ?? '';
    args.splice(i, 2);
    return result;
  };
const tenant = take('--tenant'),
  url = take('--url'),
  jsonMode = args.includes('--json');
if (jsonMode) args.splice(args.indexOf('--json'), 1);
const command = args.shift() ?? 'help';
const { startTelemetry } = await import('../../infrastructure/observability.js');
const telemetry = ['serve', 'worker'].includes(command) ? startTelemetry() : undefined;
process.once('beforeExit', () => {
  void telemetry?.shutdown();
});

const output = (value: unknown) => console.log(JSON.stringify(value, null, jsonMode ? 0 : 2));
const stdin = async () => {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks)
    .toString()
    .replace(/\r?\n$/u, '');
};
async function main() {
  if (['help', '--help'].includes(command)) {
    console.log(
      `Local RAG SaaS CLI\nLocal: init | bootstrap <login> [--name company] (password via stdin) | serve | worker | seed | prepare-local\nAPI: login <login> (password via stdin) | logout | tenant-use <id> | api <action> [input.json]\nContent: upload <file> <collection> [--document id --revision n --upload id] | download <document> <file> | review <document> | publish <document>\nChat: ask <question> [--file path] | search <question> | export <conversation> <file>\nJobs: watch <id> | cancel <id> | retry <id>\nSync: sync <connector-id> <directory> [--watch]\nAdministration: secrets|models|tenants|indexes|users|groups|collections|jobs|settings|quality|backup|usage|cache|audit <action> [input.json]\nFlags: --tenant id --url origin --json\nmodels pricing <id> --text 0.20 --image 0.45 --audio 6.50 --video 12 --output 0 sets USD per million tokens.\nmodels status [id] checks installed model availability; check and diagnose inspect the active installation.`,
    );
    return;
  }
  if (
    ['init', 'bootstrap', 'serve', 'worker', 'seed', 'prepare-local', 'check'].includes(command)
  ) {
    const { loadDeployment } = await import('../../config/saas-config.js');
    const { openApplication } = await import('../../app/bootstrap.js');
    if (command === 'prepare-local') {
      const { prepareMediaRuntime } =
        await import('../../infrastructure/media-runtime/installer.js');
      await prepareMediaRuntime();
      console.log('Local media runtime prepared.');
      return;
    }
    const app = await openApplication(loadDeployment(), command === 'init');
    if (command === 'serve') {
      const { createHttpServer } = await import('../http/server.js');
      const server = createHttpServer(app);
      await new Promise<void>((r, reject) => {
        server.once('error', reject);
        server.listen(app.s.config.port, app.s.config.host, r);
      });
      console.log(`API listening on ${app.s.config.host}:${app.s.config.port}`);
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
        await app.close();
      };
      process.once('SIGINT', () => {
        void stop();
      });
      process.once('SIGTERM', () => {
        void stop();
      });
      return;
    }
    if (command === 'worker') {
      await app.s.queue.runWorker();
      console.log('Worker ready: ' + app.s.config.worker);
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        await app.close();
      };
      process.once('SIGINT', () => {
        void stop();
      });
      process.once('SIGTERM', () => {
        void stop();
      });
      return;
    }
    try {
      if (command === 'bootstrap')
        output(
          await app.s.identity.bootstrap(
            args[0] ?? 'admin',
            await stdin(),
            take('--name') || 'Workspace',
          ),
        );
      else if (command === 'seed') {
        if (app.s.config.environment === 'production' || !app.s.config.allowTestAI)
          throw new Error('Seed is only allowed in explicitly configured development/test.');
        if (!(await app.s.identity.initialized())) {
          const first = await app.s.identity.bootstrap('admin', 'local-development-only', 'Demo A');
          const users = await app.s.db.query<{ id: string }>(
            'SELECT id FROM users WHERE operator ORDER BY id LIMIT 1',
          );
          await app.s.identity.createTenant(users[0]!.id, 'Demo B');
          console.log('Development account: admin / local-development-only');
          output(first);
        } else console.log('Development seed already exists.');
      } else if (command === 'check') {
        const result = await app.s.db.query('SELECT 1');
        output({
          postgres: result.length === 1,
          redis: app.s.cache.healthy,
          storage: await app.s.storage.health(),
        });
      } else console.log('Database, queue and storage initialized.');
    } finally {
      await app.close();
    }
    return;
  }
  if (command === 'accept-invite') {
    const base = url || process.env.RAG_URL || 'http://127.0.0.1:3210';
    const r = await fetch(base + '/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: args[0], password: await stdin() }),
    });
    const result = (await r.json()) as { error?: { message: string } };
    if (!r.ok) throw new Error(result.error?.message ?? 'Invitation failed');
    output(result);
    return;
  }
  if (command === 'login') {
    const base = url || process.env.RAG_URL || 'http://127.0.0.1:3210';
    const response = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: args[0], password: await stdin(), cli: true }),
    });
    const result = (await response.json()) as {
      token?: string;
      user?: { tenant: string };
      error?: { message: string };
    };
    if (!response.ok || !result.token || !result.user)
      throw new Error(result.error?.message ?? 'Login failed.');
    await saveCredentials({
      format: contractSignature,
      url: base,
      token: result.token,
      tenant: tenant || result.user.tenant,
    });
    console.log('Signed in.');
    return;
  }
  const saved = await credentials();
  if (tenant) saved.tenant = tenant;
  if (url) saved.url = url;
  const api = new ApiClient(saved);
  if (command === 'models' && args[0] === 'pricing') {
    const profile = (await api.action('models.list', {})).find((p) => p.id === args[1]);
    if (!profile) throw new Error('Model profile not found.');
    const price = (flag: string) => {
      const raw = take(flag),
        value = Number(raw);
      if (
        !raw ||
        !Number.isFinite(value) ||
        value < 0 ||
        !Number.isSafeInteger(Math.round(value * 1e6))
      )
        throw new Error(`Specify ${flag} as non-negative USD per million tokens.`);
      return Math.round(value * 1e6);
    };
    profile.inputMicrosPerMillion = {
      text: price('--text'),
      image: price('--image'),
      audio: price('--audio'),
      video: price('--video'),
    };
    profile.outputMicrosPerMillion = price('--output');
    output(await api.action('models.save', { profile }));
    return;
  }
  if (command === 'models' && args[0] === 'status') {
    const profiles = await api.action('models.list', {});
    const selected = args[1] ? profiles.filter((p) => p.id === args[1]) : profiles;
    if (!selected.length) throw new Error('Model profile not found.');
    const statuses = [];
    for (const p of selected) {
      const status = await api.action('models.check', { id: p.id });
      statuses.push({ id: p.id, name: p.name, model: p.model, enabled: p.enabled, ...status });
    }
    output(statuses);
    if (statuses.some((p) => p.enabled && !p.ok)) process.exitCode = 1;
    return;
  }
  if (command === 'tenant-use') {
    const tenants = await api.action('tenants.list', {});
    if (!tenants.some((t) => t.id === args[0])) throw new Error('Company is unavailable.');
    saved.tenant = args[0]!;
    await saveCredentials(saved);
    console.log('Company selected.');
    return;
  }
  if (command === 'logout') {
    await api.request('/api/logout', {});
    await rm(
      resolve(
        process.env.RAG_CLI_FILE ??
          resolve((await import('node:os')).homedir(), '.local/share/local-rag/cli.json'),
      ),
      { force: true },
    );
    return;
  }
  if (command === 'upload') {
    const document = take('--document'),
      rev = take('--revision'),
      upload = take('--upload');
    output(
      await api.upload(
        resolve(args[0]!),
        { collection: args[1]!, ...(document ? { document, revision: Number(rev) } : {}) },
        upload || undefined,
      ),
    );
    return;
  }
  if (command === 'review') {
    output(await api.action('documents.read', { id: args[0]! }));
    return;
  }
  if (command === 'publish') {
    const detail = await api.action('documents.read', { id: args[0]! });
    const job = await api.action('documents.publish', {
      id: detail.document.id,
      revision: detail.document.revision,
      version: detail.version.id,
      acknowledge: true,
      activate: true,
    });
    output(await api.wait(job.id));
    return;
  }
  if (command === 'download' || command === 'export') {
    const endpoint =
      command === 'download'
        ? '/api/documents/' + args[0]
        : ' /api/conversations/' + args[0] + '/export';
    const response = await fetch(saved.url + endpoint.trim(), {
      headers: { Authorization: 'Bearer ' + saved.token, 'X-Tenant-ID': saved.tenant },
    });
    if (!response.ok || !response.body) throw new Error('Download failed: ' + response.status);
    const { Readable } = await import('node:stream');
    const { pipeline } = await import('node:stream/promises');
    const { createWriteStream } = await import('node:fs');
    await pipeline(
      Readable.from(
        (async function* () {
          const reader = response.body!.getReader();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              yield value;
            }
          } finally {
            reader.releaseLock();
          }
        })(),
      ),
      createWriteStream(resolve(args[1]!), { flags: 'wx', mode: 0o600 }),
    );
    return;
  }
  if (command === 'ask') {
    const file = take('--file'),
      conversation = await api.action('conversations.create', {});
    const attachments: string[] = [];
    if (file) {
      const upload = await api.upload(resolve(file), { conversation: conversation.id });
      if (upload.job) await api.wait(upload.job.id);
      const detail = await api.action('documents.read', { id: upload.document.id });
      const published = await api.action('documents.publish', {
        id: detail.document.id,
        revision: detail.document.revision,
        version: detail.version.id,
        acknowledge: true,
      });
      await api.wait(published.id);
      attachments.push(detail.document.id);
    }
    const result = await api.action('answers.create', {
      conversation: conversation.id,
      revision: conversation.revision,
      question: args.join(' '),
      attachments,
      idempotencyKey: randomUUID(),
    });
    let printed = '';
    const job = await api.wait(result.job.id, (snapshot) => {
      const answer = snapshot.turn?.answer ?? '';
      if (!jsonMode && answer.startsWith(printed)) {
        process.stdout.write(answer.slice(printed.length));
        printed = answer;
      }
    });
    if (jsonMode)
      output({
        job,
        conversation: await api.action('conversations.read', { id: conversation.id }),
      });
    else {
      console.log();
      if (job.status === 'failed' || job.status === 'interrupted')
        throw new Error(job.error + ': ' + JSON.stringify(job.result));
    }
    return;
  }
  if (command === 'search') {
    output(await api.action('search', { question: args.join(' ') }));
    return;
  }
  if (command === 'watch') {
    output(
      await api.wait(args[0]!, (snapshot) => {
        if (!jsonMode) console.error(snapshot.job.status);
      }),
    );
    return;
  }
  if (command === 'cancel' || command === 'retry') {
    output(await api.action(command === 'cancel' ? 'jobs.cancel' : 'jobs.retry', { id: args[0]! }));
    return;
  }
  if (command === 'sync') {
    const watch = args.includes('--watch');
    if (watch) args.splice(args.indexOf('--watch'), 1);
    do {
      const id = args[0]!,
        directory = resolve(args[1]!);
      const connectors = await api.action('sync.list', {});
      const connector = connectors.find((c) => c.id === id);
      if (!connector) throw new Error('Connector not found.');
      const limits = await api.action('documents.limits', {});
      const files: { path: string; name: string; hash: string; bytes: number }[] = [];
      const walk = async (dir: string, depth = 0): Promise<void> => {
        if (depth > 64 || files.length > 100000) throw new Error('Directory limit exceeded.');
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (
            entry.isDirectory() &&
            !['.git', 'node_modules', '.cache', '.venv'].includes(entry.name)
          )
            await walk(path, depth + 1);
          else if (
            entry.isFile() &&
            limits.supported.some((ext) => entry.name.toLowerCase().endsWith('.' + ext))
          ) {
            const hash = createHash('sha256');
            for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
            files.push({
              path: path.slice(directory.length + 1),
              name: entry.name,
              hash: hash.digest('hex'),
              bytes: (await stat(path)).size,
            });
          }
        }
      };
      await walk(directory);
      const preview = await api.action('sync.preview', { id, files });
      const mapping: SyncFolder['mapping'] = { ...connector.mapping };
      for (const file of preview.files) {
        if (file.status === 'new' || file.status === 'update') {
          if (!files.some((local) => local.path === file.path && local.hash === file.hash))
            throw new Error('The server requested a file outside the submitted local manifest.');
          const old = file.document
            ? await api.action('documents.read', { id: file.document })
            : undefined;
          const result = await api.upload(join(directory, file.path), {
            collection: connector.collection,
            ...(old ? { document: old.document.id, revision: old.document.revision } : {}),
          });
          mapping[file.path] = { document: result.document.id, hash: file.hash };
        } else if (file.status === 'removed') {
          if (connector.policy !== 'keep') {
            const doc = await api.action('documents.read', { id: file.document });
            if (connector.policy === 'delete')
              await api.action('documents.delete', {
                id: doc.document.id,
                revision: doc.document.revision,
              });
            else
              await api.action('documents.update', {
                id: doc.document.id,
                revision: doc.document.revision,
                state: 'excluded',
              });
          }
          delete mapping[file.path];
        }
      }
      output(await api.action('sync.report', { id, revision: connector.revision, mapping }));
      if (watch)
        await new Promise((r) => setTimeout(r, Math.max(1, connector.intervalMinutes) * 60000));
    } while (watch);
    return;
  }
  const special: Record<string, string> = {
    diagnose: 'diagnostics',
    operations: 'operations',
    cleanup: 'cleanup',
  };
  let action = special[command];
  if (!action) {
    if (command === 'api') action = args.shift();
    else action = command + '.' + (args.shift() ?? 'list');
  }
  if (!action) throw new Error('Specify an API action.');
  const input = args[0]
    ? (JSON.parse(await readFile(resolve(args[0]), 'utf8')) as unknown)
    : process.stdin.isTTY
      ? {}
      : (JSON.parse((await stdin()) || '{}') as unknown);
  output(await api.action(action as ActionName, input as ActionInputs[ActionName]));
}
void main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'Command failed');
  process.exitCode = 1;
});
