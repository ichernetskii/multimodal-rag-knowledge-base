import { randomUUID } from 'node:crypto';
import { cpus, freemem, totalmem, loadavg } from 'node:os';
import { access, statfs } from 'node:fs/promises';
import type { Services } from '../../application/services.js';
import type { Documents, StoredIndex } from '../documents/saas-documents.js';
import type {
  Principal,
  Settings,
  ModelProfile,
  IndexBuild,
  Tenant,
  Job,
  User,
  Group,
  DocumentRecord,
  BackupRecord,
  UsageReport,
} from '../../contracts/public.js';
import type { StoredVersion } from '../../domain/entities.js';
import { defaults } from '../../config/default-settings.js';
import { embeddingIdentity } from '../models/ai-service.js';
import { schemaSignature } from '../../infrastructure/database/postgres-schema.js';
import { string, revision, strings, object } from '../../shared/input.js';
import type { Input } from '../../shared/input.js';
import { AppError, requireValue } from '../../shared/errors.js';
import { extractionHealth } from '../../infrastructure/extraction/health.js';
import { mediaCommand, mediaProcess } from '../../infrastructure/extraction/media-process.js';
import { defaultWhisperModel } from '../../config/media-runtime.js';
import { deliveryMetrics } from '../../application/delivery-metrics.js';
import { passwordHash } from '../identity/saas-identity.js';
export class Administration {
  constructor(
    readonly s: Services,
    readonly documents: Documents,
  ) {}
  async settings(user: Principal, p?: Input) {
    this.s.identity.admin(user);
    if (!p) return this.s.identity.settings();
    return this.s.db.transaction(async () => {
      await this.s.db.lock('settings');
      const current = await this.s.identity.settings();
      revision(p, current);
      const changes = object(p, 'settings'),
        allowed = defaults();
      for (const [key, value] of Object.entries(changes)) {
        requireValue(
          Object.hasOwn(allowed, key) && key !== 'revision',
          'INVALID_INPUT',
          `Unsupported setting: ${key}.`,
        );
        const previous = current[key as keyof Settings];
        requireValue(
          typeof value === typeof previous,
          'INVALID_INPUT',
          `Incorrect setting: ${key}.`,
        );
        if (typeof value === 'number')
          requireValue(
            Number.isSafeInteger(value) && value >= 0 && value <= 10 ** 13,
            'INVALID_INPUT',
            `Invalid limit: ${key}.`,
          );
      }
      const next = { ...current, ...changes, revision: current.revision + 1 };
      requireValue(
        next.prompt.length <= 32000 &&
          next.maxTextCharacters >= 1 &&
          next.maxTextCharacters <= 8_000_000,
        'INVALID_INPUT',
        'Prompt or extracted-text limit exceeds the supported memory bounds.',
      );
      if (!user.operator)
        for (const key of [
          'maxBytes',
          'maxDocuments',
          'maxQueue',
          'storageBytes',
          'monthlyBudgetMicros',
          'answerConcurrency',
          'indexConcurrency',
        ] as const)
          requireValue(
            next[key] <= current[key],
            'PLAN_LIMIT',
            'Only the platform operator can raise company resource and spending limits.',
            403,
          );
      requireValue(
        next.maxBytes >= 1024 &&
          next.maxBytes <= 104857600 &&
          next.sessionHours >= 1 &&
          next.sessionHours <= 720 &&
          next.historyDays >= 1 &&
          next.jobDays >= 1 &&
          next.logDays >= 1 &&
          next.backupDays >= 1 &&
          next.tempHours >= 1 &&
          next.backupIntervalHours <= 8760 &&
          next.maxQueue > 0 &&
          next.maxDocuments > 0 &&
          next.maxChunks > 0 &&
          next.maxChunks <= 50000 &&
          next.maxPages > 0 &&
          next.maxPages <= 2000 &&
          next.topK >= 1 &&
          next.topK <= 20 &&
          next.answerConcurrency >= 1 &&
          next.answerConcurrency <= 64 &&
          next.indexConcurrency >= 1 &&
          next.indexConcurrency <= 32 &&
          next.maxOutputTokens >= 16 &&
          next.contextTokens >= 512 &&
          next.mediaMaxSeconds <= 1800 &&
          next.videoMaxFrames >= 1 &&
          next.videoMaxFrames <= 120 &&
          next.whisperThreads >= 1 &&
          next.whisperThreads <= 16 &&
          next.mediaImageMaxSide >= 224 &&
          next.mediaImageMaxSide <= 2048,
        'INVALID_INPUT',
        'Settings exceed supported resource bounds.',
      );
      if (next.generationProfile !== current.generationProfile)
        await this.s.ai.requireAvailable(
          await this.s.ai.profile(next.generationProfile, 'generation'),
        );
      if (next.transcriptionProfile && next.transcriptionProfile !== current.transcriptionProfile)
        await this.s.ai.requireAvailable(
          await this.s.ai.profile(next.transcriptionProfile, 'transcription'),
        );
      requireValue(
        next.embeddingProfile === current.embeddingProfile,
        'INDEX_SWITCH_REQUIRED',
        'Switch embeddings through a checked index build.',
      );
      await this.s.db.query('UPDATE tenants SET settings=$1 WHERE id=$2', [
        JSON.stringify(next),
        user.tenant,
      ]);
      await this.s.db.invalidate();
      await this.s.identity.audit(user.id, 'settings.save');
      return next;
    });
  }
  async modelsSave(user: Principal, p: Input) {
    this.s.identity.operator(user);
    const value = object(p, 'profile') as unknown as ModelProfile;
    this.s.ai.validate(value);
    return this.s.db.transaction(async () => {
      await this.s.ai.credentials.lock();
      const old = await this.s.db.get<ModelProfile>('model', value.id);
      if (old) revision(value as unknown as Input, old);
      await this.s.ai.credentials.validateReference(value);
      if (old?.role === 'embedding' && embeddingIdentity(old) !== embeddingIdentity(value)) {
        const count = await this.s.db.count('index_build', "body->>'profile'=$2", [old.id]);
        requireValue(
          !count,
          'IMMUTABLE_EMBEDDING_PROFILE',
          'Create a new embedding profile instead of changing an indexed model.',
          409,
        );
      }
      const profile = { ...value, revision: (old?.revision ?? 0) + 1 };
      await this.s.db.put('model', profile);
      await this.s.db.invalidate();
      await this.s.identity.audit(user.id, 'models.save', profile.id);
      return profile;
    });
  }
  async buildIndex(user: Principal, p: Input) {
    this.s.identity.admin(user);
    const model = await this.s.ai.profile(string(p, 'profile'), 'embedding');
    await this.s.ai.requireAvailable(model);
    const [rev] = await this.s.db.query<{ content_revision: string }>(
      'SELECT content_revision FROM tenants WHERE id=$1',
      [user.tenant],
    );
    const index: StoredIndex & { baseRevision: string } = {
      id: randomUUID(),
      profile: model.id,
      model,
      state: 'building',
      created: Date.now(),
      documents: 0,
      signature: embeddingIdentity(model),
      baseRevision: rev!.content_revision,
    };
    await this.s.db.put('index_build', index);
    return this.s.queue.create('document', { build: index.id }, user);
  }
  async processIndex(job: Job, user: Principal, signal: AbortSignal, attempt: string) {
    const index = await this.s.db.get<StoredIndex>('index_build', String(job.payload.build));
    requireValue(index, 'NOT_FOUND', 'Index build not found.', 404);
    try {
      const docs = await this.s.db.list<DocumentRecord>(
        'document',
        "body->>'state'='published'",
        [],
        100000,
      );
      for (const doc of docs) {
        const v = await this.s.db.get<StoredVersion>('version', doc.activeVersion);
        if (v) {
          const owner = doc.conversation
            ? await this.s.identity.current(doc.owner, user.tenant)
            : user;
          await this.documents.indexVersion(job, owner, v, doc, index, signal, attempt);
          index.documents++;
        }
      }
      index.state = 'ready';
      await this.s.db.transaction(async () => {
        await this.s.queue.update(
          job.id,
          { status: 'complete', result: { index: index.id, documents: index.documents } },
          attempt,
        );
        await this.s.db.put('index_build', index);
      });
    } catch (e) {
      index.state = 'failed';
      await this.s.db.put('index_build', index);
      throw e;
    }
  }
  async activateIndex(user: Principal, p: Input) {
    this.s.identity.admin(user);
    return this.s.db.transaction(async () => {
      await this.s.db.lock('index');
      const index = await this.s.db.get<StoredIndex & { baseRevision?: string }>(
        'index_build',
        string(p, 'id'),
      );
      requireValue(
        index?.state === 'ready',
        'INDEX_NOT_READY',
        'Complete and check the index first.',
        409,
      );
      await this.s.ai.requireAvailable(await this.s.ai.profile(index.profile, 'embedding'));
      const [rev] = await this.s.db.query<{ content_revision: string }>(
        'SELECT content_revision FROM tenants WHERE id=$1',
        [user.tenant],
      );
      requireValue(
        index.baseRevision === rev?.content_revision,
        'CORPUS_CHANGED',
        'Knowledge base changed during indexing. Rebuild before switching.',
        409,
      );
      for (const old of await this.s.db.list<IndexBuild>(
        'index_build',
        "body->>'state'='active'",
        [],
        100,
      )) {
        old.state = 'ready';
        await this.s.db.put('index_build', old);
      }
      index.state = 'active';
      await this.s.db.put('index_build', index);
      const settings = await this.s.identity.settings();
      settings.embeddingProfile = index.profile;
      settings.revision++;
      await this.s.db.query('UPDATE tenants SET settings=$1 WHERE id=$2', [
        JSON.stringify(settings),
        user.tenant,
      ]);
      await this.s.db.invalidate();
      await this.s.identity.audit(user.id, 'indexes.activate', index.id);
      return index;
    });
  }
  async tenants(user: Principal) {
    if (!user.operator) return this.s.identity.tenants(user.id);
    const rows = await this.s.db.query<Omit<Tenant, 'role'>>(
      'SELECT id,name,blocked,revision FROM tenants ORDER BY name',
    );
    return rows.map((v) => ({ ...v, role: 'admin' as const }));
  }
  async tenantUpdate(user: Principal, p: Input) {
    this.s.identity.operator(user);
    const id = string(p, 'id');
    const rows = await this.s.db.query<Tenant>(
      'SELECT id,name,blocked,revision FROM tenants WHERE id=$1',
      [id],
    );
    const old = rows[0];
    requireValue(old, 'NOT_FOUND', 'Company not found.', 404);
    revision(p, old);
    const name = string(p, 'name', old.name, 200),
      blocked = p.blocked === undefined ? old.blocked : p.blocked;
    requireValue(
      name.trim() && typeof blocked === 'boolean',
      'INVALID_INPUT',
      'Invalid company settings.',
    );
    await this.s.db.query(
      'UPDATE tenants SET name=$1,blocked=$2,revision=revision+1,access_revision=access_revision+1 WHERE id=$3',
      [name, blocked, id],
    );
    return { ...old, name, blocked, revision: old.revision + 1 };
  }
  async userUpdate(user: Principal, p: Input) {
    this.s.identity.admin(user);
    const rows = await this.s.db.query<User>(
      'SELECT u.id,u.login,m.role,m.groups,m.blocked,m.revision FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2',
      [user.tenant, string(p, 'id')],
    );
    const old = rows[0];
    requireValue(old, 'NOT_FOUND', 'Member not found.', 404);
    revision(p, old);
    const role = string(p, 'role', old.role);
    requireValue(['admin', 'editor', 'user'].includes(role), 'INVALID_ROLE', 'Invalid role.');
    const groups = p.groups === undefined ? old.groups : strings(p, 'groups');
    for (const group of groups)
      requireValue(await this.s.db.get('group', group), 'INVALID_GROUP', 'Group not found.');
    const blocked = p.blocked === undefined ? old.blocked : p.blocked;
    requireValue(typeof blocked === 'boolean', 'INVALID_INPUT', 'Invalid blocked flag.');
    const password = p.password ? await passwordHash(string(p, 'password')) : undefined;
    return this.s.db.transaction(async () => {
      await this.s.db.lock('identity');
      const [admins] = await this.s.db.query<{ count: string }>(
        "SELECT count(*) FROM memberships WHERE tenant_id=$1 AND role='admin' AND NOT blocked",
        [user.tenant],
      );
      requireValue(
        !(
          old.role === 'admin' &&
          !old.blocked &&
          (role !== 'admin' || blocked) &&
          Number(admins?.count) <= 1
        ),
        'LAST_ADMIN',
        'At least one active company administrator is required.',
      );
      if (password) {
        const memberships = await this.s.identity.tenants(old.id);
        requireValue(
          user.operator || memberships.length === 1,
          'GLOBAL_ACCOUNT',
          'Only the account owner or operator can change a shared account password.',
          403,
        );
        await this.s.db.query('UPDATE users SET password=$1 WHERE id=$2', [password, old.id]);
        await this.s.identity.revoke(old.id);
      }
      await this.s.db.query(
        'UPDATE memberships SET role=$1,groups=$2,blocked=$3,revision=revision+1 WHERE tenant_id=$4 AND user_id=$5',
        [role, JSON.stringify(groups), blocked, user.tenant, old.id],
      );
      await this.s.db.invalidate(true);
      await this.s.identity.audit(user.id, 'users.update', old.id);
      return { ...old, role: role as User['role'], groups, blocked, revision: old.revision + 1 };
    });
  }
  async usage() {
    const date = new Date();
    date.setUTCDate(1);
    date.setUTCHours(0, 0, 0, 0);
    const rows = await this.s.db.query<{ state: string; reserved: string; cost: string }>(
      'SELECT state,sum(reserved_micros) reserved,sum(cost_micros) cost FROM usage_ledger WHERE tenant_id=$1 AND created>=$2 GROUP BY state',
      [this.s.db.tenantId, date.getTime()],
    );
    const sum = (state: string, key: 'reserved' | 'cost') =>
      Number(rows.find((v) => v.state === state)?.[key] ?? 0);
    const [assets] = await this.s.db.query<{ bytes: string }>(
      'SELECT coalesce(sum(bytes),0) bytes FROM assets WHERE tenant_id=$1',
      [this.s.db.tenantId],
    );
    const calls = await this.s.db.query<{
      profile: string;
      calls: string;
      input: string;
      output: string;
      cost: string;
      estimated: string;
      modalities: UsageReport['calls'][number]['modalities'];
    }>(
      `SELECT profile,count(*) calls,sum(input_tokens) input,sum(output_tokens) output,sum(cost_micros) cost,
       count(*) FILTER(WHERE billing->>'estimated'='true') estimated,
       jsonb_build_object(${['text', 'image', 'audio', 'video', 'unattributed']
         .map((m) => {
           const path =
             m === 'unattributed' ? "billing->'unattributed'" : `billing->'input'->'${m}'`;
           return `'${m}',jsonb_build_object('tokens',coalesce(sum((${path}->>'tokens')::bigint),0),'costMicros',coalesce(sum((${path}->>'costMicros')::bigint),0))`;
         })
         .join(',')}) modalities
       FROM usage_ledger WHERE tenant_id=$1 AND created>=$2 AND state='complete' GROUP BY profile`,
      [this.s.db.tenantId, date.getTime()],
    );
    return {
      month: date.toISOString().slice(0, 7),
      spentMicros: sum('complete', 'cost'),
      reservedMicros: sum('reserved', 'reserved'),
      uncertainMicros: sum('uncertain', 'reserved'),
      storageBytes: Number(assets?.bytes ?? 0),
      budgetMicros: (await this.s.identity.settings()).monthlyBudgetMicros,
      calls: calls.map((v) => ({
        profile: v.profile,
        calls: Number(v.calls),
        input: Number(v.input),
        output: Number(v.output),
        costMicros: Number(v.cost),
        estimatedCalls: Number(v.estimated),
        modalities: v.modalities,
      })),
    };
  }
  async diagnostics() {
    const [profiles, storage, workers, disk] = await Promise.all([
      this.s.db.list<ModelProfile>('model', 'true', [], 1000),
      this.s.storage.health(),
      this.s.db.query<{ kind: string; last_seen: string }>(
        'SELECT kind,max(last_seen) last_seen FROM workers WHERE last_seen>$1 GROUP BY kind',
        [Date.now() - 15000],
      ),
      statfs(this.s.config.tempDir),
    ]);
    const settings = await this.s.identity.settings();
    const probe = async (name: 'ffmpeg' | 'ffprobe' | 'whisper') => {
      try {
        const output = await mediaProcess(
          mediaCommand(name),
          [name === 'whisper' ? '--help' : name === 'ffmpeg' ? '-encoders' : '-version'],
          AbortSignal.timeout(5000),
        );
        if (name === 'ffmpeg' && !output.includes('libx264'))
          return {
            ok: false,
            message:
              'FFmpeg was built without H.264 (libx264). Run yarn prepare:media or rebuild the image.',
          };
        return { ok: true, message: '' };
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof AppError
              ? error.message
              : 'Cannot start the tool. Check its installation and executable path.',
        };
      }
    };
    const [ffmpeg, ffprobe, whisper, model, extraction] = await Promise.all([
      probe('ffmpeg'),
      probe('ffprobe'),
      probe('whisper'),
      access(defaultWhisperModel()).then(
        () => true,
        () => false,
      ),
      extractionHealth(settings.ocrLanguage),
    ]);
    return {
      media: {
        ffmpeg: ffmpeg.ok,
        ffprobe: ffprobe.ok,
        whisper: whisper.ok,
        model,
        issues: Object.fromEntries<string>(
          (
            [
              ['ffmpeg', ffmpeg.message],
              ['ffprobe', ffprobe.message],
              ['whisper', whisper.message],
              ['model', model ? '' : 'Whisper weights were not found. Run yarn prepare:media.'],
            ] as const
          ).filter(([, message]) => message),
        ),
      },
      extraction,
      dependencies: {
        embedding: profiles.some((p) => p.role === 'embedding' && p.enabled),
        generation: profiles.some((p) => p.role === 'generation' && p.enabled),
        indexSignature: schemaSignature,
        models: profiles.map((p) => p.model),
      },
      indexCompatible: true,
      directoryWritable: true,
      freeBytes: Number(disk.bavail) * Number(disk.bsize),
      postgres: true,
      redis: this.s.cache.healthy,
      storage,
      workers: workers.map((w) => ({ kind: w.kind, lastSeen: Number(w.last_seen) })),
      ready: storage && workers.length > 0,
      hardware: {
        cpu: cpus()[0]?.model ?? '',
        cores: cpus().length,
        totalMemory: totalmem(),
        freeMemory: freemem(),
      },
      dataDir: this.s.config.tempDir,
    };
  }
  async operations() {
    const settings = await this.s.identity.settings(),
      jobs = await this.s.db.list<Job>(
        'job',
        "body->>'status' NOT IN('complete','no_info','clarification','cancelled','interrupted','failed')",
        [],
        10000,
      );
    const disk = await statfs(this.s.config.tempDir);
    const usage = await this.usage();
    const [response] = await this.s.db.query<{ mean: string; errors: string; samples: string }>(
      "SELECT coalesce(avg((body->>'updated')::bigint-(body->>'created')::bigint),0) mean,count(*) FILTER(WHERE body->>'status' IN('failed','interrupted')) errors,count(*) samples FROM jobs WHERE tenant_id=$1 AND body->>'kind'='answer' AND (body->>'created')::bigint>$2 AND body->>'status' IN('complete','no_info','clarification','failed','interrupted')",
      [this.s.db.tenantId, Date.now() - 86400000],
    );
    const [tenant] = await this.s.db.query<{ maintenance: boolean }>(
      'SELECT maintenance FROM tenants WHERE id=$1',
      [this.s.db.tenantId],
    );
    const info = this.s.cache.healthy
      ? await this.s.cache.client
          .withCommandOptions({ timeout: 1500 })
          .info('memory')
          .catch(() => '')
      : '';
    return {
      sse: {
        streams: Number(
          (
            await this.s.db.query<{ count: string }>(
              'SELECT count(*) count FROM resource_leases WHERE scope LIKE $1 AND expires>$2',
              ['sse:tenant:' + this.s.db.tenantId, Date.now()],
            )
          )[0]?.count ?? 0,
        ),
        peakBuffered: deliveryMetrics.peakBuffered,
        slowDisconnects: deliveryMetrics.slowDisconnects,
      },
      cpu: { load: loadavg(), cores: cpus().length, process: process.cpuUsage() },
      memory: { total: totalmem(), free: freemem(), process: process.memoryUsage() },
      freeBytes: Number(disk.bavail) * Number(disk.bsize),
      queue: {
        length: jobs.length,
        oldestAgeMs: jobs.length ? Date.now() - Math.min(...jobs.map((j) => j.created)) : 0,
        lanes: ['answer', 'document', 'evaluation', 'maintenance'].map((kind) => {
          const q = jobs.filter((j) => j.kind === kind);
          return {
            kind,
            length: q.length,
            oldestAgeMs: q.length ? Date.now() - Math.min(...q.map((j) => j.created)) : 0,
          };
        }),
      },
      counts: {
        users: (await this.s.identity.users('', 100000)).length,
        documents: await this.s.db.count('document'),
        conversations: await this.s.db.count('conversation'),
        collections: await this.s.db.count('collection'),
      },
      running: jobs.filter((j) => j.status !== 'queued'),
      response: {
        meanMs: Number(response?.mean ?? 0),
        errorRate: Number(response?.errors ?? 0) / Math.max(1, Number(response?.samples ?? 0)),
        samples: Number(response?.samples ?? 0),
        windowHours: 24,
      },
      dataBytes: usage.storageBytes,
      cacheBytes: Number(/^used_memory:(\d+)/mu.exec(info)?.[1] ?? 0),
      events: await this.s.db.count('audit'),
      backups: await this.s.db.list<BackupRecord>('backup', 'true', [], 100),
      settings,
      maintenance: tenant?.maintenance ?? false,
    };
  }
  async saveGroup(user: Principal, p: Input) {
    this.s.identity.admin(user);
    const id = string(p, 'id', randomUUID()),
      old = await this.s.db.get<Group>('group', id);
    if (old) revision(p, old);
    const group = { id, name: string(p, 'name', '', 200), revision: (old?.revision ?? 0) + 1 };
    requireValue(group.name.trim(), 'INVALID_INPUT', 'Group name required.');
    await this.s.db.put('group', group);
    await this.s.db.invalidate(true);
    return group;
  }
}
