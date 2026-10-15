import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { serveApplication } from '../../app/bootstrap.js';
import type { User, Job, Diagnostics } from '../../domain/entities.js';
import { restoreInstallation } from '../../features/backup/backup-service.js';
import { passwordHash } from '../../features/identity/auth-service.js';
import { Catalog } from '../../infrastructure/database/catalog.js';
import { AppError, requireValue } from '../../shared/errors.js';
import {
  api,
  apiOrigin,
  dataDirectory as directory,
  sessionPath as session,
  download,
} from './api-client.js';
import { Auth } from '../../features/identity/auth-service.js';
function password() {
  const value = readFileSync(0, 'utf8').replace(/\r?\n$/u, '');
  requireValue(
    value.length >= 12,
    'PASSWORD_POLICY',
    'Передайте пароль через stdin (12+ символов).',
  );
  return value;
}
async function waitJob(id: string) {
  let previous = '';
  const deadline = Date.now() + 1800_000;
  while (Date.now() < deadline) {
    const job = (await api('jobs.read', { id })) as Job;
    if (job.status !== previous) {
      console.error(`Задание ${id}: ${job.status}`);
      previous = job.status;
    }
    if (
      !['queued', 'searching', 'generating', 'indexing', 'ocr', 'extracting'].includes(job.status)
    )
      return job;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new AppError(
    'JOB_WAIT_TIMEOUT',
    `Задание ${id} ещё выполняется. Его состояние сохранено; проверьте через api jobs.read.`,
    504,
  );
}
export async function runCliCommand(command: string, args: string[]) {
  if (command === 'serve') {
    await serveApplication();
    return;
  }
  if (command === 'login') {
    const result = (await api('/api/login', {
      login: args[0],
      password: password(),
      cli: true,
    })) as { token: string };
    mkdirSync(directory(), { recursive: true, mode: 0o700 });
    writeFileSync(session(), result.token, { mode: 0o600 });
    console.log('Вход выполнен.');
    return;
  }
  if (command === 'logout') {
    await api('/api/logout', {});
    rmSync(session(), { force: true });
    console.log('Выход выполнен.');
    return;
  }
  if (command === 'recover-admin') {
    requireValue(
      ['127.0.0.1', 'localhost', '[::1]'].includes(apiOrigin().hostname),
      'RECOVERY_LOCAL_ONLY',
      'Для восстановления задайте RAG_URL локального сервера. Ключ восстановления не передаётся удалённому серверу.',
      403,
    );
    const login = args[0];
    requireValue(login, 'INVALID_INPUT', 'recover-admin <login> — пароль через stdin.');
    const pw = password();
    if (existsSync(join(directory(), '.writer-lock'))) {
      const key = readFileSync(join(directory(), 'recovery.key'), 'utf8').trim();
      console.log(await api('/api/recover', { login, password: pw }, key));
    } else {
      const db = new Catalog(directory());
      try {
        const stored = await passwordHash(pw);
        const user = db.find<User>('user', 'name=?', [login], 'id', 1)[0];
        requireValue(user, 'NOT_FOUND', 'Для создания первого администратора используйте мастер.');
        user.password = stored;
        user.role = 'admin';
        user.blocked = false;
        user.revision++;
        db.transaction(() => {
          db.put('user', user);
          new Auth(db).revoke(user.id);
        });
        console.log('Административный доступ восстановлен.');
      } finally {
        db.close();
      }
    }
    return;
  }
  if (command === 'restore-installation') {
    requireValue(
      args[0] && args[1],
      'INVALID_INPUT',
      'restore-installation <backup.sqlite> <target-directory>',
    );
    console.log(
      JSON.stringify(await restoreInstallation(resolve(args[0]), resolve(args[1])), null, 2),
    );
    return;
  }
  if (command === 'api') {
    requireValue(
      args[0],
      'INVALID_INPUT',
      'api <action> [input.json] (без файла: JSON через stdin)',
    );
    const input = JSON.parse(
      args[1] ? readFileSync(args[1], 'utf8') : readFileSync(0, 'utf8') || '{}',
    ) as Record<string, unknown>;
    console.log(JSON.stringify(await api(args[0], input), null, 2));
    return;
  }
  if (command === 'upload') {
    requireValue(
      args[0] && args[1],
      'INVALID_INPUT',
      'upload <file> <collection-id> [document-id revision]',
    );
    requireValue(
      statSync(resolve(args[0])).size <= 100 * 1024 * 1024,
      'FILE_LIMIT',
      'Максимальный размер файла — 100 МиБ.',
    );
    const bytes = readFileSync(resolve(args[0]));
    console.log(
      JSON.stringify(
        await api('documents.upload', {
          name: basename(args[0]),
          base64: bytes.toString('base64'),
          collection: args[1],
          ...(args[2] ? { document: args[2], revision: Number(args[3]) } : {}),
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'search') {
    console.log(JSON.stringify(await api('search', { question: args.join(' ') }), null, 2));
    return;
  }
  if (command === 'ask') {
    const c = (await api('conversations.create', {})) as { id: string; revision: number };
    const result = (await api('answers.create', {
      conversation: c.id,
      revision: c.revision,
      question: args.join(' '),
    })) as { job: { id: string } };
    const job = await waitJob(result.job.id);
    console.log(JSON.stringify(await api('conversations.read', { id: c.id }), null, 2));
    requireValue(
      !['failed', 'interrupted'].includes(job.status),
      job.error || 'ANSWER_FAILED',
      'Генерация не завершена.',
    );
    return;
  }
  if (command === 'download' || command === 'export') {
    requireValue(
      args[0] && args[1],
      'INVALID_INPUT',
      command === 'download'
        ? 'download <document-id> <output> [version-id]'
        : 'export <conversation-id> <output.json>',
    );
    const id = encodeURIComponent(args[0]),
      path =
        command === 'download'
          ? `/api/documents/${id}?download=1${args[2] ? '&version=' + encodeURIComponent(args[2]) : ''}`
          : `/api/conversations/${id}/export`;
    console.log(await download(path, args[1]));
    return;
  }
  if (command === 'quality-check') {
    const queued = (await api('quality.run', {})) as Job,
      job = await waitJob(queued.id);
    console.log(JSON.stringify({ job }, null, 2));
    let page = 1,
      totalPages: number;
    do {
      const result = (await api('quality.results', { job: job.id, page, pageSize: 100 })) as {
        items: unknown[];
        total: number;
        pageSize: number;
      };
      console.log(JSON.stringify(result.items, null, 2));
      totalPages = Math.ceil(result.total / result.pageSize);
      page++;
    } while (page <= totalPages);
    requireValue(
      job.status === 'complete' && Number(job.result.failed) === 0,
      job.error || 'QUALITY_FAILED',
      'Контрольные вопросы не прошли проверку.',
      422,
    );
    return;
  }
  const shortcuts: Record<string, string> = {
    operations: 'operations',
    backup: 'backup.create',
    backups: 'backup.list',
    cleanup: 'cleanup',
  };
  if (command === 'diagnose') {
    const diagnostics = (await api('diagnostics', {})) as Diagnostics;
    console.log(JSON.stringify(diagnostics, null, 2));
    requireValue(
      diagnostics.dependencies.embedding &&
        diagnostics.dependencies.generation &&
        diagnostics.extraction.pdf &&
        diagnostics.extraction.ocr &&
        diagnostics.indexCompatible &&
        diagnostics.directoryWritable &&
        diagnostics.sqliteIntegrity === 'ok' &&
        diagnostics.ready,
      'DIAGNOSTICS_FAILED',
      'Одна или несколько проверок установки не прошли. См. отчёт выше.',
      503,
    );
    return;
  }
  const action = shortcuts[command];
  requireValue(action, 'UNKNOWN_COMMAND', 'Неизвестная команда. Выполните help.');
  console.log(JSON.stringify(await api(action, {}), null, 2));
}
