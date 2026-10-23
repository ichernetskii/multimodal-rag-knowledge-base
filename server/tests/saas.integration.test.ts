import { test } from 'node:test';
import { credentialScenario } from './credential-scenario.js';
import { billingScenario } from './billing-scenario.js';
import { transcriptionScenario } from './transcription-scenario.js';
import { materialTextScenario } from './material-text-scenario.js';
import { documentReaderScenario } from './document-reader-scenario.js';
import { attachmentScenario } from './attachment-scenario.js';
import { revisionScenario } from './revision-scenario.js';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { openApplication } from '../src/app/bootstrap.js';
import { loadDeployment } from '../src/config/saas-config.js';
import { createHttpServer } from '../src/interfaces/http/server.js';
import type {
  ActionInputs,
  ActionName,
  ActionResults,
  Principal,
} from '../src/contracts/public.js';
import { terminal } from '../src/contracts/public.js';

void test(
  'SaaS: durable jobs, multipart S3, citations, tenant/ACL isolation, backup and restore',
  { skip: process.env.RUN_INTEGRATION !== '1', timeout: 300000 },
  async (t) => {
    process.loadEnvFile(new URL('../../.env', import.meta.url));
    const config = loadDeployment({
      ...process.env,
      NODE_ENV: 'test',
      ALLOW_TEST_AI: '1',
      DEFAULT_GENERATION_PROVIDER: 'test',
      DEFAULT_EMBEDDING_PROVIDER: 'test',
    });
    const app = await openApplication(config);
    const suffix = randomUUID();
    const account = await app.s.identity.login(
      'admin',
      'local-development-only',
      'integration-' + suffix,
    );
    const a = await app.s.identity.createTenant(account.user.id, 'Integration A ' + suffix);
    const b = await app.s.identity.createTenant(account.user.id, 'Integration B ' + suffix);
    const user = await app.s.identity.current(account.user.id, a.id);
    const other = await app.s.identity.current(account.user.id, b.id);
    const call = <N extends ActionName>(
      action: N,
      input: ActionInputs[N],
      principal: Principal = user,
    ) =>
      app.execute(action, input as Record<string, unknown>, principal) as Promise<ActionResults[N]>;
    const wait = async (id: string) => {
      const deadline = Date.now() + 60000;
      let logged = 0;
      while (Date.now() < deadline) {
        const job = await call('jobs.read', { id });
        if (Date.now() - logged > 5000) {
          console.log(job.kind, job.status, JSON.stringify(job.result));
          logged = Date.now();
        }
        if (terminal.has(job.status)) {
          assert.ok(['complete', 'no_info'].includes(job.status), JSON.stringify(job));
          return job;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('Job deadline exceeded: ' + id);
    };
    const server = createHttpServer(app);
    try {
      const failedName = 'Failed company creation ' + suffix;
      const audit = t.mock.method(app.s.identity, 'audit', async () => {
        throw new Error('Simulated audit write failure');
      });
      try {
        await assert.rejects(call('tenants.create', { name: failedName }), /Simulated audit/u);
      } finally {
        audit.mock.restore();
      }
      assert.equal(
        (await app.s.db.query('SELECT id FROM tenants WHERE name=$1', [failedName])).length,
        0,
        'Failed company creation must roll back the company, membership, and profiles together.',
      );
      await app.s.queue.runWorker();
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const origin = 'http://127.0.0.1:' + address.port;
      const unauthorized = await fetch(origin + '/api/actions/collections.list', {
        method: 'POST',
        body: '{}',
      });
      assert.equal(unauthorized.status, 401);
      for (const scope of [[], '', 42, true])
        for (const action of ['search', 'documents.list'])
          await assert.rejects(
            app.execute(
              action,
              { ...(action === 'search' ? { question: 'Invalid scope' } : {}), scope },
              user,
            ),
            { code: 'INVALID_INPUT' },
          );
      await credentialScenario(app, config, user, other, origin, account.token);
      await billingScenario(app, user, other);
      await transcriptionScenario(app, user);
      await materialTextScenario(app, user);
      await documentReaderScenario(app, user);
      await revisionScenario(app, user);
      const kb = await call('collections.save', { name: 'Personnel', grants: [] });
      const renames = await Promise.allSettled([
        call('collections.rename', { id: kb.id, revision: kb.revision, name: 'Personnel A' }),
        call('collections.rename', { id: kb.id, revision: kb.revision, name: 'Personnel B' }),
      ]);
      assert.equal(renames.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(renames.filter((result) => result.status === 'rejected').length, 1);
      const renamed = renames.find((result) => result.status === 'fulfilled');
      assert.ok(renamed?.status === 'fulfilled');
      Object.assign(kb, renamed.value);
      assert.deepEqual(await call('collections.list', {}, other), []);
      await assert.rejects(
        call('collections.rename', { id: kb.id, revision: kb.revision, name: 'foreign' }, other),
        /not found/i,
      );
      await app.s.db.tenant(b.id, user.id, async () => {
        assert.equal(
          (await app.s.db.query('SELECT * FROM collections WHERE id=$1', [kb.id])).length,
          0,
        );
      });
      const data = Buffer.from(
        'Отпуск нужно запрашивать за 14 календарных дней. Vacation requests must be submitted 14 calendar days before the start date. Equipment XZ-417 service interval is 60 days.',
      );
      const upload = await call('uploads.create', {
        collection: kb.id,
        name: 'policy.txt',
        bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      });
      await app.s.db.tenant(a.id, user.id, () =>
        app.documents.uploadPart(user, upload.id, 0, data),
      );
      const uploaded = await call('documents.upload', { upload: upload.id });
      assert.ok(uploaded.job);
      await wait(uploaded.job.id);
      assert.equal(
        (await call('collections.list', {})).find((item) => item.id === kb.id)?.documentCount,
        1,
      );
      const detail = await call('documents.read', { id: uploaded.document.id });
      assert.equal(detail.version.state, 'review');
      await assert.rejects(
        call('documents.update', {
          id: detail.document.id,
          revision: detail.document.revision,
          state: 'published',
        }),
        /Open the document/u,
      );
      await assert.rejects(
        call('documents.publish', {
          id: detail.document.id,
          revision: detail.document.revision,
          version: detail.version.id,
        }),
        /acknowledge/i,
      );
      await assert.rejects(
        call(
          'documents.correct',
          {
            id: detail.document.id,
            revision: detail.document.revision,
            version: detail.version.id,
            page: 1,
            text: 'foreign change',
          },
          other,
        ),
        /not found/i,
      );
      const originalPage = await call('documents.page', {
        id: detail.document.id,
        version: detail.version.id,
        page: 1,
      });
      const corrected = await call('documents.correct', {
        id: detail.document.id,
        revision: detail.document.revision,
        version: detail.version.id,
        page: originalPage.number,
        text: originalPage.text + '\nReviewed correction Q-204.',
      });
      const reviewed = await call('documents.read', { id: detail.document.id });
      assert.equal(reviewed.version.hash, detail.version.hash);
      assert.equal(reviewed.version.acknowledged, false);
      assert.match(
        (
          await call('documents.page', {
            id: detail.document.id,
            version: reviewed.version.id,
            page: 1,
          })
        ).text,
        /Q-204/,
      );
      await assert.rejects(
        call('documents.correct', {
          id: detail.document.id,
          revision: detail.document.revision,
          version: detail.version.id,
          page: 1,
          text: 'stale change',
        }),
        /changed/u,
      );
      Object.assign(detail.document, corrected);
      await wait(
        (
          await call('documents.publish', {
            id: detail.document.id,
            revision: detail.document.revision,
            version: detail.version.id,
            acknowledge: true,
          })
        ).id,
      );
      const published = await call('documents.read', { id: detail.document.id });
      await assert.rejects(
        call('documents.correct', {
          id: detail.document.id,
          revision: published.document.revision,
          version: detail.version.id,
          page: 1,
          text: 'published change',
        }),
        /unpublished/i,
      );
      const found = await call('search', { question: 'За сколько дней нужно запрашивать отпуск?' });
      assert.ok(found.length > 0);
      const conversation = await call('conversations.create', {});
      const request = {
        conversation: conversation.id,
        revision: conversation.revision,
        question: 'За сколько дней нужно запрашивать отпуск?',
        idempotencyKey: randomUUID(),
      };
      const accepted = await call('answers.create', request);
      const duplicate = await call('answers.create', request);
      assert.equal(accepted.job.id, duplicate.job.id);
      await wait(accepted.job.id);
      const history = await call('conversations.read', { id: conversation.id });
      assert.match(history.turns[0]!.answer, /14/);
      assert.ok(history.turns[0]!.sources.length);
      const source = history.turns[0]!.sources[0]!;
      assert.ok(await call('sources.read', { chunk: source.chunk }));
      await assert.rejects(
        call('conversations.read', { id: conversation.id }, other),
        /not found/i,
      );
      const reader = await call('users.create', {
        login: 'reader-' + suffix,
        password: 'integration-password',
        role: 'user',
      });
      const restricted = await app.s.identity.current(reader.id, a.id);
      assert.deepEqual(await call('search', { question: 'vacation' }, restricted), []);
      const granted = await call('collections.save', {
        id: kb.id,
        revision: kb.revision,
        name: kb.name,
        grants: [{ subject: reader.id, access: 'read' }],
      });
      assert.ok((await call('search', { question: 'vacation' }, restricted)).length);
      await call('collections.save', {
        id: kb.id,
        revision: granted.revision,
        name: kb.name,
        grants: [],
      });
      assert.deepEqual(await call('search', { question: 'vacation' }, restricted), []);
      const invitation = await call(
        'invitations.create',
        { login: reader.login, role: 'user' },
        other,
      );
      await app.s.identity.acceptInvitation(invitation.token, 'integration-password');
      assert.equal((await app.s.identity.current(reader.id, b.id)).tenant, b.id);
      await assert.rejects(
        app.s.identity.acceptInvitation(invitation.token, 'integration-password'),
        /expired|revoked/i,
      );
      await call('feedback.create', { turn: history.turns[0]!.id, rating: 1, reason: 'other' });
      await call('quality.save', {
        question: 'Vacation notice?',
        scope: { collection: kb.id },
        documents: [uploaded.document.id],
        facts: ['14'],
        refuse: false,
      });
      const evaluation = await call('quality.run', {});
      await wait(evaluation.id);
      await attachmentScenario(app, user, wait);
      const connector = await call('sync.save', {
        collection: kb.id,
        path: 'Local folder',
        policy: 'keep',
        intervalMinutes: 1,
      });
      await call('sync.report', {
        id: connector.id,
        revision: connector.revision,
        mapping: { 'policy.txt': { document: uploaded.document.id, hash: detail.version.hash } },
      });
      // Exercise a genuine multi-part resume and a version larger than a small backup batch.
      const large = Buffer.from('Ж'.repeat(4_500_000)),
        largeHash = createHash('sha256').update(large).digest('hex');
      const largeUpload = await call('uploads.create', {
        collection: kb.id,
        name: 'large-unicode.txt',
        bytes: large.length,
        sha256: largeHash,
      });
      await app.s.db.tenant(a.id, user.id, () =>
        app.documents.uploadPart(user, largeUpload.id, 0, large.subarray(0, largeUpload.partBytes)),
      );
      const resumed = await call('uploads.read', { id: largeUpload.id });
      assert.equal(resumed.offset, largeUpload.partBytes);
      await assert.rejects(
        app.s.db.tenant(a.id, user.id, () =>
          app.documents.uploadPart(user, resumed.id, 0, large.subarray(0, 10)),
        ),
        /Resume at byte/,
      );
      await app.s.db.tenant(a.id, user.id, () =>
        app.documents.uploadPart(user, resumed.id, resumed.offset, large.subarray(resumed.offset)),
      );
      const largeDocument = await call('documents.upload', { upload: resumed.id });
      assert.ok(largeDocument.job);
      await wait(largeDocument.job.id);
      const backupKey = await call('secrets.save', {
        id: 'backup-' + suffix,
        label: 'Backup isolation',
        provider: 'google',
        enabled: true,
        revision: 0,
        value: 'synthetic-before-backup',
      });
      const backup = await call('backup.create', {});
      await wait(backup.id);
      const backups = await call('backup.list', {});
      assert.ok(backups[0]);
      await call('backup.verify', { id: backups[0].id });
      await call('secrets.save', {
        id: backupKey.id,
        label: backupKey.label,
        provider: backupKey.provider,
        enabled: true,
        revision: backupKey.revision,
        value: 'synthetic-after-backup',
      });
      await app.s.db.tenant(a.id, user.id, async () => {
        const record = await app.s.db.get<{ manifest: string }>('backup', backups[0]!.id);
        const manifest = JSON.parse((await app.s.storage.bytes(record!.manifest)).toString()) as {
          parts: { table: string }[];
        };
        assert.ok(
          manifest.parts.every(
            (part) => !['ai_credentials', 'credential_audits'].includes(part.table),
          ),
        );
      });
      const beforeRestoreSettings = await call('settings.read', {});
      await call('settings.save', {
        revision: beforeRestoreSettings.revision,
        settings: { monthlyBudgetMicros: beforeRestoreSettings.monthlyBudgetMicros - 1_000_000 },
      });
      const originalEmbedding = (await call('models.list', {})).find(
        (p) => p.role === 'embedding',
      )!;
      await call('models.save', {
        profile: {
          ...originalEmbedding,
          inputMicrosPerMillion: { text: 1_000_000, image: 0, audio: 0, video: 0 },
        },
      });
      await call('search', { question: 'runtime price verification ' + suffix });
      const billedAfterSnapshot = (await call('usage.read', {})).spentMicros;
      assert.ok(
        billedAfterSnapshot > 0,
        'Current prices apply without rebuilding existing vectors.',
      );
      const adminMember = await call('users.create', {
        login: 'admin-' + suffix,
        password: 'integration-password',
        role: 'admin',
      });
      const administrator = await app.s.identity.current(adminMember.id, a.id);
      const latest = await call('documents.read', { id: uploaded.document.id });
      await call('documents.delete', {
        id: latest.document.id,
        revision: latest.document.revision,
      });
      assert.equal((await call('search', { question: 'vacation' })).length, 0);
      const redacted = await call('conversations.read', { id: conversation.id });
      assert.equal(redacted.turns[0]!.redacted, true);
      await app.s.db.tenant(a.id, user.id, async () => {
        const raw = await app.s.db.get<{ answer: string; sources: unknown[] }>(
          'turn',
          history.turns[0]!.id,
        );
        assert.equal(raw?.answer, '');
        assert.deepEqual(raw.sources, []);
      });
      assert.equal((await call('quality.list', {})).checks.length, 0);
      assert.equal((await call('quality.results', { job: evaluation.id })).items.length, 0);
      assert.deepEqual(
        (await call('sync.list', {})).find((c) => c.id === connector.id)!.mapping,
        {},
      );

      await wait((await call('backup.restore', { id: backups[0].id }, administrator)).id);
      await app.s.db.tenant(a.id, user.id, async () =>
        assert.equal(
          await app.s.ai.credentials.resolve({
            ...originalEmbedding,
            provider: 'google',
            secretRef: backupKey.id,
          }),
          'synthetic-after-backup',
        ),
      );
      const retainedKey = (await call('secrets.list', {})).find((k) => k.id === backupKey.id)!;
      await call('secrets.delete', { id: retainedKey.id, revision: retainedKey.revision });
      assert.equal(
        (await call('settings.read', {})).monthlyBudgetMicros,
        beforeRestoreSettings.monthlyBudgetMicros - 1_000_000,
      );
      assert.ok(
        (await call('usage.read', {})).spentMicros >= billedAfterSnapshot,
        'A tenant restore must not rewind billing.',
      );
      assert.equal(
        (await call('models.list', {})).find((p) => p.id === originalEmbedding.id)
          ?.inputMicrosPerMillion.text,
        1_000_000,
      );
      const restoredLarge = await call('documents.read', { id: largeDocument.document.id });
      const largePage = await call('documents.page', {
        id: largeDocument.document.id,
        version: restoredLarge.version.id,
        page: 1,
      });
      assert.equal(largePage.totalCharacters, 4_500_000);
      assert.equal(largePage.text.length, 12000);
      assert.ok(
        JSON.stringify(restoredLarge).length < 10000,
        'Metadata does not download the entire extracted text.',
      );
      assert.ok((await call('search', { question: 'vacation' })).length);
      assert.deepEqual(await call('collections.list', {}, other), []);
      const profiles = await call('models.list', {}),
        embedding = profiles.find((p) => p.role === 'embedding')!;
      const alternate = await call('models.save', {
        profile: {
          ...embedding,
          id: randomUUID(),
          revision: 0,
          name: 'Alternative vector space',
          dimensions: 1536,
        },
      });
      const build = await call('indexes.build', { profile: alternate.id });
      await wait(build.id);
      const indexes = await call('indexes.list', {}),
        staged = indexes.find((i) => i.profile === alternate.id)!;
      assert.equal(staged.state, 'ready');
      const disabledAlternate = await call('models.save', {
        profile: { ...alternate, enabled: false },
      });
      await assert.rejects(call('indexes.activate', { id: staged.id }), /enabled model/i);
      assert.equal((await call('settings.read', {})).embeddingProfile, originalEmbedding.id);
      await call('models.save', { profile: { ...disabledAlternate, enabled: true } });
      await assert.rejects(call('indexes.activate', { id: staged.id }), /changed during indexing/i);
      const rebuilt = await wait((await call('indexes.build', { profile: alternate.id })).id);
      await call('indexes.activate', { id: String(rebuilt.result.index) });
      assert.ok((await call('search', { question: 'vacation' })).length);
      assert.ok(
        await call('sources.read', { chunk: source.chunk }),
        'Historical provenance survives rebuilding the vector space.',
      );
      const settings = await call('settings.read', {});
      await assert.rejects(
        call(
          'settings.save',
          {
            revision: settings.revision,
            settings: { monthlyBudgetMicros: settings.monthlyBudgetMicros + 1 },
          },
          administrator,
        ),
        /operator/i,
      );
      await assert.rejects(call('models.save', { profile: alternate }, administrator), /operator/i);
      await assert.rejects(call('diagnostics', {}, administrator), /operator/i);
      const companyProfiles = await call('models.list', {}, administrator);
      assert.ok(companyProfiles.length > 0);
      assert.ok(companyProfiles.every((p) => p.endpoint === '' && p.secretRef === ''));
      assert.ok((await call('models.list', {})).some((p) => p.endpoint !== ''));
      const disabled = await call('models.save', {
        profile: { ...alternate, id: randomUUID(), revision: 0, enabled: false },
      });
      assert.ok(!(await call('models.list', {}, administrator)).some((p) => p.id === disabled.id));
      await assert.rejects(
        call('tenants.create', { name: 'Forbidden company' }, administrator),
        /operator/i,
      );
      await assert.rejects(
        call('conversations.read', { id: conversation.id }, administrator),
        /not found/i,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await app.s.queue.close();
      try {
        const temporaryAccounts = new Set<string>();
        for (const tenant of [a.id, b.id]) {
          await app.s.db.tenant(tenant, user.id, async () => {
            for (const member of await app.s.db.query<{ user_id: string }>(
              'SELECT user_id FROM memberships WHERE tenant_id=$1 AND user_id<>$2',
              [tenant, account.user.id],
            ))
              temporaryAccounts.add(member.user_id);
            // These tables have tenant RLS but no cascading tenant foreign key.
            await app.s.db.query('DELETE FROM idempotency WHERE tenant_id=$1', [tenant]);
            await app.s.db.query('DELETE FROM usage_ledger WHERE tenant_id=$1', [tenant]);
          });
          for (const prefix of ['tenants/' + tenant + '/', 'backups/' + tenant + '/'])
            for (const key of await app.s.storage.keys(prefix)) await app.s.storage.remove(key);
          await app.s.db.query("DELETE FROM pgboss.job WHERE data->>'tenant'=$1", [tenant]);
          await app.s.db.query('DELETE FROM tenants WHERE id=$1', [tenant]);
        }
        for (const id of temporaryAccounts)
          await app.s.db.query(
            'DELETE FROM users WHERE id=$1 AND NOT operator AND NOT EXISTS(SELECT 1 FROM memberships_for_user($1))',
            [id],
          );
        await app.s.db.query('DELETE FROM ai_credentials WHERE id=$1', ['backup-' + suffix]);
      } finally {
        await app.close();
      }
    }
  },
);
