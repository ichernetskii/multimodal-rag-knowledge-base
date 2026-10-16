import type { Services } from './services.js';
import { Retention } from '../features/operations/retention-service.js';
import { KnowledgeBases } from '../features/knowledge-bases/knowledge-base-service.js';
import { Documents } from '../features/documents/saas-documents.js';
import { Search } from '../features/search/saas-search.js';
import { Chat } from '../features/chat/saas-chat.js';
import { Administration } from '../features/operations/saas-admin.js';
import { Backups } from '../features/backup/saas-backup.js';
import { Quality } from '../features/quality/saas-quality.js';
import { Synchronization } from '../features/sync/saas-sync.js';
import { actionFields, terminal } from '../contracts/public.js';
import type {
  ActionName,
  Principal,
  DocumentRecord,
  Conversation,
  Turn,
  Job,
  ModelProfile,
  Source,
  CheckQuestion,
  EvaluationRecord,
  SyncFolder,
  Group,
  Invitation,
} from '../contracts/public.js';
import { string, number, strings, revision, object } from '../shared/input.js';
import type { Input } from '../shared/input.js';
import { requireValue } from '../shared/errors.js';
import { passwordHash } from '../features/identity/saas-identity.js';
export class Application {
  readonly documents;
  readonly knowledgeBases;
  readonly retention;
  readonly search;
  readonly chat;
  readonly administration;
  readonly backups;
  readonly quality;
  readonly sync;
  readonly actions: Record<string, (user: Principal, p: Input) => Promise<unknown>>;
  constructor(readonly s: Services) {
    this.documents = new Documents(s);
    this.knowledgeBases = new KnowledgeBases(s, this.documents);
    this.retention = new Retention(s, this.documents);
    this.search = new Search(s, this.documents);
    this.chat = new Chat(s, this.documents, this.search);
    this.administration = new Administration(s, this.documents);
    this.backups = new Backups(s);
    this.quality = new Quality(s, this.documents, this.search);
    this.sync = new Synchronization(s, this.documents);
    this.actions = {
      me: async (user) => {
        const [row] = await s.db.query<{ access_revision: string; content_revision: string }>(
          'SELECT access_revision,content_revision FROM tenants WHERE id=$1',
          [user.tenant],
        );
        return {
          user,
          tenants: await s.identity.tenants(user.id),
          permissionsVersion: Number(row?.access_revision),
          contentVersion: Number(row?.content_revision),
        };
      },
      'invitations.list': async (u) => {
        s.identity.admin(u);
        return (await s.db.list<Invitation & { hash: string }>('invitation', 'true', [], 1000)).map(
          ({ hash, ...item }) => {
            void hash;
            return item;
          },
        );
      },
      'invitations.create': (u, p) =>
        s.identity.invite(u, string(p, 'login'), string(p, 'role', 'user') as Principal['role']),
      'invitations.revoke': async (u, p) => {
        s.identity.admin(u);
        await s.db.remove('invitation', string(p, 'id'));
        return { ok: true };
      },
      'collections.delete': (u, p) => this.knowledgeBases.remove(u, p),
      'tenants.list': (u) => this.administration.tenants(u),
      'tenants.create': async (u, p) => {
        s.identity.operator(u);
        return s.identity.createTenant(u.id, string(p, 'name'));
      },
      'tenants.update': (u, p) => this.administration.tenantUpdate(u, p),
      'collections.list': (u) => this.knowledgeBases.list(u),
      'collections.save': (u, p) => this.knowledgeBases.save(u, p),
      'collections.rename': (u, p) => this.knowledgeBases.rename(u, p),
      'groups.list': async (u) => {
        s.identity.admin(u);
        return s.db.list<Group>('group', 'true', [], 10000);
      },
      'groups.save': (u, p) => this.administration.saveGroup(u, p),
      'users.list': async (u, p) => {
        s.identity.admin(u);
        const page = Math.max(1, number(p, 'page', 1)),
          pageSize = Math.min(100, Math.max(1, number(p, 'pageSize', 25)));
        const items = await s.identity.users(string(p, 'query'), pageSize, (page - 1) * pageSize);
        const [row] = await s.db.query<{ count: string }>(
          'SELECT count(*) FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND u.login ILIKE $2',
          [u.tenant, '%' + string(p, 'query') + '%'],
        );
        return { items, total: Number(row?.count), page, pageSize };
      },
      'users.create': async (u, p) => {
        s.identity.admin(u);
        const role = string(p, 'role', 'user');
        requireValue(['user', 'editor', 'admin'].includes(role), 'INVALID_INPUT', 'Invalid role.');
        return s.identity.createUser(
          string(p, 'login', '', 200),
          string(p, 'password'),
          role as Principal['role'],
          strings(p, 'groups'),
          p.blocked === true,
        );
      },
      'users.update': (u, p) => this.administration.userUpdate(u, p),
      'users.revoke': async (u, p) => {
        s.identity.operator(u);
        const id = string(p, 'id');
        const [member] = await s.db.query(
          'SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2',
          [u.tenant, id],
        );
        requireValue(member, 'NOT_FOUND', 'Member not found.', 404);
        await s.identity.revoke(id);
        await s.db.invalidate(true);
        return { ok: true };
      },
      'password.change': async (u, p) => {
        const [account] = await s.db.query<{ login: string }>(
          'SELECT login FROM users WHERE id=$1',
          [u.id],
        );
        const verification = await s.identity.login(
          account!.login,
          string(p, 'oldPassword'),
          'password-change',
        );
        await s.identity.logout(verification.token);
        const password = await passwordHash(string(p, 'password'));
        await s.db.query('UPDATE users SET password=$1 WHERE id=$2', [password, u.id]);
        await s.identity.revoke(u.id);
        return { ok: true };
      },
      'sessions.list': async (u) =>
        s.db.query(
          'SELECT id,created,expires FROM sessions WHERE user_id=$1 ORDER BY created DESC LIMIT 100',
          [u.id],
        ),
      'sessions.revoke': async (u, p) => {
        await s.db.query('DELETE FROM sessions WHERE id=$1 AND user_id=$2', [
          string(p, 'id'),
          u.id,
        ]);
        return { ok: true };
      },
      'documents.limits': async () => {
        const settings = await s.identity.settings();
        return {
          maxBytes: settings.maxBytes,
          maxDocuments: settings.maxDocuments,
          supported: this.documents.supported(),
        };
      },
      'documents.list': (u, p) => this.documents.list(u, p),
      'documents.read': (u, p) => this.documents.details(u, string(p, 'id'), string(p, 'version')),
      'documents.preview': async (u, p) => {
        const selection = await this.documents.scope(u, {
          collection: string(p, 'collection'),
          conversation: string(p, 'conversation'),
        });
        const files = p.files;
        requireValue(
          Array.isArray(files) && files.length <= 100,
          'INVALID_INPUT',
          'Invalid file list.',
        );
        const settings = await s.identity.settings();
        const result = [];
        for (const value of files) {
          const f = value as Input,
            name = string(f, 'name', '', 255),
            hash = string(f, 'hash'),
            bytes = number(f, 'bytes');
          const matches = await s.db.list<DocumentRecord>(
            'document',
            "body->>'collection'=$2 AND body->>'conversation'=$3 AND body->>'name'=$4",
            [selection.collection ?? '', selection.conversation ?? '', name],
            1,
          );
          const old = matches[0];
          const versions = old
            ? await s.db.list('version', "document_id=$2 AND body->>'hash'=$3", [old.id, hash], 1)
            : [];
          result.push({
            name,
            status:
              bytes > settings.maxBytes
                ? 'limit'
                : versions.length
                  ? 'duplicate'
                  : old
                    ? 'update'
                    : 'new',
            ...(old ? { document: old.id, revision: old.revision } : {}),
          });
        }
        return result;
      },
      'uploads.create': (u, p) => this.documents.createUpload(u, p),
      'uploads.read': async (u, p) =>
        this.documents.publicUpload(await this.documents.upload(u, string(p, 'id'))),
      'documents.upload': (u, p) => this.documents.finishUpload(u, string(p, 'upload')),
      'documents.publish': (u, p) => this.documents.publish(u, p),
      'documents.correct': (u, p) => this.documents.correct(u, p),
      'documents.update': async (u, p) =>
        s.db.transaction(async () => {
          await s.db.lock('access');
          const doc = await this.documents.document(u, string(p, 'id'), true);
          revision(p, doc);
          if (p.name !== undefined) doc.name = string(p, 'name', '', 255);
          if (p.state !== undefined) {
            requireValue(
              ['published', 'excluded', 'archived', 'draft'].includes(string(p, 'state')),
              'INVALID_INPUT',
              'Invalid state.',
            );
            requireValue(
              p.state !== 'published' || doc.activeVersion,
              'VERSION_NOT_READY',
              'Сначала откройте документ, проверьте обработанную версию и нажмите «Текст проверен · опубликовать». Состояние изменится после индексации.',
            );
            if (p.state !== 'published') await this.documents.cancelJobs(u, doc.id);
            doc.state = p.state as DocumentRecord['state'];
          }
          doc.revision++;
          await s.db.put('document', doc);
          await s.db.invalidate(true);
          return doc;
        }),
      'documents.delete': async (u, p) => {
        const d = await this.documents.document(u, string(p, 'id'), true);
        revision(p, d);
        await this.documents.remove(u, d.id);
        return { ok: true };
      },
      'documents.bulk': async (u, p) =>
        this.s.db.transaction(async () => {
          await s.db.lock('access');
          const ids = strings(p, 'ids'),
            revisions = object(p, 'revisions'),
            operation = string(p, 'operation');
          requireValue(
            ['archive', 'exclude', 'delete'].includes(operation) && ids.length <= 100,
            'INVALID_INPUT',
            'Invalid bulk operation.',
          );
          for (const id of ids) {
            const doc = await this.documents.document(u, id, true);
            revision({ revision: revisions[id] }, doc);
          }
          for (const id of ids)
            if (operation === 'delete') await this.documents.remove(u, id);
            else {
              const d = await this.documents.document(u, id, true);
              await this.documents.cancelJobs(u, id);
              d.state = operation === 'archive' ? 'archived' : 'excluded';
              d.revision++;
              await s.db.put('document', d);
            }
          await s.db.invalidate(true);
          return { count: ids.length };
        }),
      'documents.compare': async (u, p) => ({
        left: (await this.documents.details(u, string(p, 'id'), string(p, 'left'))).version.pages,
        right: (await this.documents.details(u, string(p, 'id'), string(p, 'right'))).version.pages,
      }),
      'documents.restore': async (u, p) => {
        const detail = await this.documents.details(u, string(p, 'id'), string(p, 'version'));
        revision(p, detail.document);
        await this.documents.publish(u, { ...p, acknowledge: true, activate: true });
        return detail.document;
      },
      'sources.read': async (u, p) => {
        const [row] = await s.db.query<{ body: Source }>(
          'SELECT body FROM source_fragments WHERE tenant_id=$1 AND id=$2',
          [u.tenant, string(p, 'chunk')],
        );
        requireValue(
          row && (await this.documents.permittedSource(u, row.body)),
          'NOT_FOUND',
          'Source not found.',
          404,
        );
        const detail = await this.documents.details(u, row.body.document, row.body.version);
        return {
          document: detail.document,
          version: detail.version,
          page: detail.version.pages.find((v) => v.number === row.body.page),
          source: row.body,
        };
      },
      search: async (u, p) =>
        this.search.search(
          u,
          string(p, 'question'),
          await this.documents.scope(u, (p.scope ?? {}) as Input),
        ),
      'conversations.create': (u, p) => this.chat.create(u, p),
      'conversations.list': async (u, p) => {
        const page = Math.max(1, number(p, 'page', 1)),
          pageSize = Math.min(100, Math.max(1, number(p, 'pageSize', 25))),
          where = "owner_id=$2 AND body->>'title' ILIKE $3",
          values = [u.id, '%' + string(p, 'query') + '%'];
        return {
          items: await s.db.list<Conversation>(
            'conversation',
            where,
            values,
            pageSize,
            (page - 1) * pageSize,
          ),
          total: await s.db.count('conversation', where, values),
          page,
          pageSize,
        };
      },
      'conversations.read': (u, p) => this.chat.read(u, p),
      'conversations.save': async (u, p) => {
        const c = await this.chat.owns(u, string(p, 'id'));
        revision(p, c);
        for (const key of ['title', 'draft', 'selected'] as const)
          if (p[key] !== undefined) c[key] = string(p, key);
        if (c.selected) {
          const turn = await s.db.get<Turn>('turn', c.selected);
          requireValue(
            turn?.conversation === c.id,
            'INVALID_INPUT',
            'Selected turn belongs to another conversation.',
          );
        }
        c.revision++;
        c.updated = Date.now();
        return s.db.put('conversation', c);
      },
      'conversations.delete': async (u, p) => {
        const c = await this.chat.owns(u, string(p, 'id'));
        revision(p, c);
        const docs = await s.db.list<DocumentRecord>(
          'document',
          'conversation_id=$2',
          [c.id],
          100000,
        );
        for (const d of docs) await this.documents.remove(u, d.id);
        const jobs = await s.db.list<Job>(
          'job',
          "body->'payload'->>'conversation'=$2",
          [c.id],
          100000,
        );
        for (const j of jobs) if (!terminal.has(j.status)) await s.queue.cancel(u, j.id);
        await s.db.remove('conversation', c.id);
        await s.db.invalidate(true);
        return { ok: true };
      },
      'conversations.variants': async (u, p) => {
        const id = string(p, 'id');
        await this.chat.owns(u, id);
        const page = Math.max(1, number(p, 'page', 1)),
          pageSize = Math.min(100, Math.max(1, number(p, 'pageSize', 25))),
          where = "conversation_id=$2 AND body->>'parent'=$3",
          values = [id, string(p, 'parent')];
        return {
          items: await s.db.list<Turn>('turn', where, values, pageSize, (page - 1) * pageSize),
          total: await s.db.count('turn', where, values),
          page,
          pageSize,
        };
      },
      'answers.create': (u, p) => this.chat.answer(u, p),
      'jobs.read': (u, p) => s.queue.read(u, string(p, 'id')),
      'jobs.cancel': (u, p) => s.queue.cancel(u, string(p, 'id')),
      'jobs.retry': (u, p) => s.queue.retry(u, string(p, 'id')),
      'jobs.list': async (u, p) => {
        const page = Math.max(1, number(p, 'page', 1)),
          pageSize = Math.min(100, Math.max(1, number(p, 'pageSize', 25))),
          where = u.role === 'admin' ? 'true' : "body->>'owner'=$2",
          values = u.role === 'admin' ? [] : [u.id];
        return {
          items: await s.db.list<Job>('job', where, values, pageSize, (page - 1) * pageSize),
          total: await s.db.count('job', where, values),
          page,
          pageSize,
        };
      },
      'settings.read': (u) => this.administration.settings(u),
      'settings.save': (u, p) => this.administration.settings(u, p),
      'secrets.list': (u) => s.ai.credentials.list(u),
      'secrets.save': (u, p) => s.ai.credentials.save(u, p),
      'secrets.delete': (u, p) => s.ai.credentials.remove(u, p),
      'secrets.audit': (u, p) => s.ai.credentials.history(u, p),
      'models.list': async (u) => {
        const profiles = await s.db.list<ModelProfile>('model', 'true', [], 1000);
        if (u.operator) return profiles;
        const settings = await s.identity.settings();
        const selected = [
          settings.generationProfile,
          settings.embeddingProfile,
          settings.transcriptionProfile,
        ];
        return profiles
          .filter((p) => p.enabled || (u.role === 'admin' && selected.includes(p.id)))
          .map((p) => ({ ...p, endpoint: '', secretRef: '' }));
      },
      'models.save': (u, p) => this.administration.modelsSave(u, p),
      'models.delete': async (u, p) => {
        s.identity.operator(u);
        const id = string(p, 'id'),
          model = await s.db.get<ModelProfile>('model', id);
        requireValue(model, 'NOT_FOUND', 'Profile not found.', 404);
        revision(p, model);
        const settings = await s.identity.settings();
        requireValue(
          !(await s.db.count('index_build', "body->>'profile'=$2", [id])),
          'PROFILE_IN_USE',
          'Profile is referenced by an index.',
          409,
        );
        requireValue(
          ![
            settings.generationProfile,
            settings.embeddingProfile,
            settings.transcriptionProfile,
          ].includes(id),
          'PROFILE_IN_USE',
          'Profile is selected in company settings.',
          409,
        );
        await s.db.remove('model', id);
        await s.db.invalidate();
        return { ok: true };
      },
      'models.check': async (u, p) => {
        s.identity.admin(u);
        const model = await s.db.get<ModelProfile>('model', string(p, 'id'));
        requireValue(model, 'NOT_FOUND', 'Profile not found.', 404);
        return s.ai.health(model);
      },
      'indexes.list': async (u) => {
        s.identity.admin(u);
        return s.db.list('index_build', 'true', [], 1000);
      },
      'indexes.build': (u, p) => this.administration.buildIndex(u, p),
      'indexes.activate': (u, p) => this.administration.activateIndex(u, p),
      'usage.read': async (u) => {
        s.identity.admin(u);
        return this.administration.usage();
      },
      'cache.clear': async (u) => {
        s.identity.admin(u);
        await s.db.invalidate();
        await s.cache.clearTenant(u.tenant);
        await s.identity.audit(u.id, 'cache.clear');
        return { ok: true };
      },
      'audit.list': async (u, p) => {
        s.identity.admin(u);
        const page = Math.max(1, number(p, 'page', 1)),
          pageSize = Math.min(100, Math.max(1, number(p, 'pageSize', 25)));
        return {
          items: await s.db.list('audit', 'true', [], pageSize, (page - 1) * pageSize),
          total: await s.db.count('audit'),
          page,
          pageSize,
        };
      },
      operations: async (u) => {
        s.identity.admin(u);
        return this.administration.operations();
      },
      diagnostics: async (u) => {
        s.identity.operator(u);
        return this.administration.diagnostics();
      },
      'quality.list': (u, p) => this.quality.report(u, p),
      'quality.save': (u, p) => this.quality.save(u, p),
      'quality.delete': async (u, p) => {
        s.identity.admin(u);
        const check = await s.db.get<CheckQuestion>('check_question', string(p, 'id'));
        requireValue(check, 'NOT_FOUND', 'Check not found.', 404);
        revision(p, check);
        await s.db.remove('check_question', check.id);
        return { ok: true };
      },
      'quality.run': async (u) => {
        s.identity.admin(u);
        return s.queue.create('evaluation', {}, u);
      },
      'quality.results': async (u, p) => {
        s.identity.admin(u);
        const job = string(p, 'job');
        await s.queue.read(u, job);
        const page = Math.max(1, number(p, 'page', 1)),
          pageSize = Math.min(100, Math.max(1, number(p, 'pageSize', 25))),
          where = "body->>'job'=$2";
        const items = await s.db.list<EvaluationRecord>(
          'evaluation',
          where,
          [job],
          pageSize,
          (page - 1) * pageSize,
        );
        for (const item of items)
          for (const source of item.sources)
            if (!(await this.documents.permittedSource(u, source))) {
              item.answer = 'Access revoked';
              item.sources = [];
              item.expected = { documents: [], facts: [], refuse: false };
              item.redacted = true;
              break;
            }
        return { items, total: await s.db.count('evaluation', where, [job]), page, pageSize };
      },
      'feedback.create': (u, p) => this.quality.feedback(u, p),
      'sync.list': async (u) => {
        const values = u.role === 'admin' ? [] : [u.id];
        return s.db.list<SyncFolder>(
          'sync',
          u.role === 'admin' ? 'true' : "body->>'owner'=$2",
          values,
          10000,
        );
      },
      'sync.save': (u, p) => this.sync.save(u, p),
      'sync.preview': (u, p) => this.sync.preview(u, p),
      'sync.report': (u, p) => this.sync.report(u, p),
      'sync.delete': async (u, p) => {
        const value = await this.sync.owned(u, string(p, 'id'));
        revision(p, value);
        await s.db.remove('sync', value.id);
        return { ok: true };
      },
      'backup.create': (u) => this.backups.create(u),
      'backup.list': async (u) => {
        s.identity.admin(u);
        return s.db.list('backup', 'true', [], 1000);
      },
      'backup.verify': async (u, p) => {
        const { manifest } = await this.backups.verify(u, string(p, 'id'));
        return {
          id: manifest.id,
          integrity: 'ok',
          entities: manifest.parts.map((part) => ({ table: part.table, rows: part.rows })),
        };
      },
      'backup.restore': async (u, p) => {
        s.identity.admin(u);
        await this.backups.verify(u, string(p, 'id'));
        return s.queue.create('maintenance', { operation: 'restore', backup: string(p, 'id') }, u);
      },
      cleanup: async (u) => {
        s.identity.admin(u);
        return s.queue.create('maintenance', { operation: 'cleanup' }, u);
      },
    };
    const registered = new Set([...Object.keys(this.actions), 'setup.status']);
    for (const action of Object.keys(actionFields))
      requireValue(registered.has(action), 'ACTION_NOT_REGISTERED', `Missing action: ${action}`);
    s.queue.schedule = () => this.schedule();
    s.queue.handler = async (job, user, signal, attempt) => {
      if (job.kind === 'answer') await this.chat.process(job, user, signal, attempt);
      else if (job.kind === 'document') {
        if (job.payload.build) await this.administration.processIndex(job, user, signal, attempt);
        else await this.documents.process(job, user, signal, attempt);
      } else if (job.kind === 'evaluation') await this.quality.process(job, user, signal, attempt);
      else if (job.payload.operation === 'cleanup')
        await this.retention.process(job, user, attempt);
      else await this.backups.process(job, user, signal, attempt);
    };
  }
  async execute(action: string, p: Input = {}, user?: Principal) {
    requireValue(
      Object.hasOwn(actionFields, action),
      'ACTION_NOT_FOUND',
      'Unknown API action.',
      404,
    );
    const fields: readonly string[] = actionFields[action as ActionName];
    requireValue(
      Object.keys(p).every((key) => fields.includes(key)),
      'INVALID_INPUT',
      'Request contains unsupported fields.',
    );
    if (action === 'setup.status') return { initialized: await this.s.identity.initialized() };
    requireValue(user, 'UNAUTHENTICATED', 'Sign in.', 401);
    const current = await this.s.identity.current(user.id, user.tenant);
    return this.s.db.tenant(current.tenant, current.id, async () => {
      const [tenant] = await this.s.db.query<{ maintenance: boolean }>(
        'SELECT maintenance FROM tenants WHERE id=$1',
        [current.tenant],
      );
      requireValue(
        !tenant?.maintenance ||
          ['me', 'jobs.read', 'jobs.list', 'backup.list', 'operations'].includes(action),
        'MAINTENANCE',
        'Company data is being restored.',
        503,
      );
      const handler = this.actions[action];
      requireValue(handler, 'ACTION_NOT_FOUND', 'Unknown action.', 404);
      return handler(current, p);
    });
  }
  async schedule() {
    const tenants = await this.s.db.query<{ id: string }>(
      'SELECT id FROM tenants WHERE NOT blocked AND NOT maintenance',
    );
    for (const tenant of tenants)
      await this.s.db.tenant(tenant.id, '', () =>
        this.s.db.transaction(async () => {
          await this.s.db.lock('scheduler');
          const [admin] = await this.s.db.query<{ user_id: string }>(
            "SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE tenant_id=$1 AND role='admin' AND NOT m.blocked AND NOT u.blocked LIMIT 1",
            [tenant.id],
          );
          if (!admin) return;
          const user = await this.s.identity.current(admin.user_id, tenant.id),
            settings = await this.s.identity.settings();
          if (settings.pauseIntake) return;
          const recent = await this.s.db.list<Job>('job', "body->>'kind'='maintenance'", [], 100);
          if (
            !recent.some(
              (j) => j.payload.operation === 'cleanup' && j.created > Date.now() - 3600000,
            )
          )
            await this.s.queue.create(
              'maintenance',
              { operation: 'cleanup', scheduled: true },
              user,
            );
          if (
            settings.backupIntervalHours > 0 &&
            !recent.some(
              (j) =>
                j.payload.operation === 'backup' &&
                j.created > Date.now() - settings.backupIntervalHours * 3600000,
            )
          )
            await this.backups.create(user);
        }),
      );
  }
  async close() {
    await this.s.queue.close();
    await this.s.cache.close();
    this.s.storage.close();
    await this.s.db.close();
  }
}
