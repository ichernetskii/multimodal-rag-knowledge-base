import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Application } from '../src/application/application.js';
import type {
  ActionInputs,
  ActionName,
  ActionResults,
  DocumentRecord,
  Principal,
} from '../src/contracts/public.js';
import { terminal } from '../src/contracts/public.js';
import type { Asset, StoredVersion } from '../src/domain/entities.js';
import { AppError } from '../src/shared/errors.js';

export async function revisionScenario(app: Application, operator: Principal) {
  const tenant = await app.s.identity.createTenant(
    operator.id,
    'Revision verification ' + randomUUID(),
  );
  const owner = await app.s.identity.current(operator.id, tenant.id),
    accounts: string[] = [];
  const run = <T>(work: () => Promise<T>) => app.s.db.tenant(tenant.id, owner.id, work);
  const call = <N extends ActionName>(action: N, input: ActionInputs[N], user = owner) =>
    app.execute(action, input as Record<string, unknown>, user) as Promise<ActionResults[N]>;
  const wait = async (id: string, status = 'complete') => {
    for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
      const job = await call('jobs.read', { id });
      if (terminal.has(job.status)) {
        assert.equal(job.status, status, JSON.stringify(job));
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Revision job timed out.');
  };
  const copy = app.s.storage.copy.bind(app.s.storage);
  try {
    const reader = await call('users.create', {
      login: 'revision-reader-' + randomUUID(),
      password: 'verification-password',
      role: 'user',
    });
    const editor = await call('users.create', {
      login: 'revision-editor-' + randomUUID(),
      password: 'verification-password',
      role: 'editor',
    });
    accounts.push(reader.id, editor.id);
    const read = await app.s.identity.current(reader.id, tenant.id),
      edit = await app.s.identity.current(editor.id, tenant.id);
    const base = await call('collections.save', {
      name: 'Revision materials',
      grants: [
        { subject: reader.id, access: 'read' },
        { subject: editor.id, access: 'edit' },
      ],
    });
    const original = await readFile(
      new URL('../../examples/knowledge-base/media/inspection.mp4', import.meta.url),
    );
    const preview = await readFile(
      new URL('../../examples/knowledge-base/media/label.png', import.meta.url),
    );
    const audio = await readFile(
      new URL('../../examples/knowledge-base/media/jfk.wav', import.meta.url),
    );
    const doc: DocumentRecord = {
      id: randomUUID(),
      revision: 1,
      name: 'reference.mp4',
      collection: base.id,
      conversation: '',
      owner: editor.id,
      state: 'published',
      activeVersion: randomUUID(),
    };
    const originalId = randomUUID(),
      previewId = randomUUID(),
      audioId = randomUUID();
    const version: StoredVersion = {
      id: doc.activeVersion,
      document: doc.id,
      name: doc.name,
      hash: createHash('sha256').update(original).digest('hex'),
      created: Date.now(),
      state: 'ready',
      acknowledged: true,
      signature: '',
      original: originalId,
      pages: [
        {
          number: 1,
          text: 'Reviewed original: 12 Nm.',
          method: 'vision',
          sections: [{ title: 'Visual description', text: 'Reviewed original: 12 Nm.' }],
          warnings: [],
          media: { kind: 'video', asset: originalId, preview: previewId, startMs: 0, endMs: 12000 },
        },
        {
          number: 2,
          text: 'Turn off power before maintenance.',
          method: 'speech',
          sections: [{ title: 'Transcript', text: 'Turn off power before maintenance.' }],
          warnings: [],
          media: { kind: 'audio', asset: audioId, startMs: 0, endMs: 11000 },
        },
      ],
    };
    await run(async () => {
      await app.s.db.put('document', doc);
      await app.s.db.put('version', version);
      await app.documents.storeAsset(doc, version, originalId, original, 'video/mp4', doc.name);
      await app.documents.storeAsset(doc, version, previewId, preview, 'image/png', 'preview.png');
      await app.documents.storeAsset(doc, version, audioId, audio, 'audio/wav', 'speech.wav');
    });
    await wait(
      (
        await call('documents.publish', {
          id: doc.id,
          revision: 1,
          version: version.id,
          acknowledge: true,
        })
      ).id,
    );
    let detail = await call('documents.read', { id: doc.id }, edit);
    const [usageBefore] = await run(() =>
      app.s.db.query<{ count: string }>('SELECT count(*) FROM usage_ledger WHERE tenant_id=$1', [
        tenant.id,
      ]),
    );
    await assert.rejects(
      call(
        'documents.revise',
        { id: doc.id, revision: detail.document.revision, version: version.id },
        read,
      ),
      /denied|requires|not found/i,
    );
    const forks = await Promise.allSettled([
      call(
        'documents.revise',
        { id: doc.id, revision: detail.document.revision, version: version.id },
        edit,
      ),
      call(
        'documents.revise',
        { id: doc.id, revision: detail.document.revision, version: version.id },
        edit,
      ),
    ]);
    assert.equal(forks.filter((result) => result.status === 'fulfilled').length, 1);
    const accepted = forks.find((result) => result.status === 'fulfilled');
    assert.ok(accepted?.status === 'fulfilled');
    await wait(accepted.value.id);
    const [usageAfter] = await run(() =>
      app.s.db.query<{ count: string }>('SELECT count(*) FROM usage_ledger WHERE tenant_id=$1', [
        tenant.id,
      ]),
    );
    assert.equal(
      usageAfter?.count,
      usageBefore?.count,
      'Creating a correction must not invoke OCR/ASR/inference or add AI charges.',
    );
    detail = await call('documents.read', { id: doc.id }, edit);
    assert.equal(detail.version.state, 'review');
    assert.notEqual(detail.version.id, version.id);
    assert.equal(detail.document.activeVersion, version.id);
    assert.equal((await call('documents.read', { id: doc.id }, read)).version.id, version.id);
    await assert.rejects(
      call('documents.read', { id: doc.id, version: detail.version.id }, read),
      /not found/i,
    );
    const copies = await run(() =>
      app.s.db.query<Asset>('SELECT * FROM assets WHERE tenant_id=$1 AND version_id=$2', [
        tenant.id,
        detail.version.id,
      ]),
    );
    assert.equal(copies.length, 3);
    const oldAssets = await run(() =>
      app.s.db.query<Asset>('SELECT * FROM assets WHERE tenant_id=$1 AND version_id=$2', [
        tenant.id,
        version.id,
      ]),
    );
    for (const asset of copies) {
      assert.ok(
        !oldAssets.some((old) => old.id === asset.id || old.object_key === asset.object_key),
      );
      assert.equal(await app.s.storage.digest(asset.object_key, Number(asset.bytes)), asset.sha256);
    }
    const copiedPage = await call(
      'documents.page',
      { id: doc.id, version: detail.version.id, page: 1 },
      edit,
    );
    assert.ok(copies.some((asset) => asset.id === copiedPage.media?.asset));
    assert.ok(copies.some((asset) => asset.id === copiedPage.media?.preview));
    const corrected = await call(
      'documents.correct',
      {
        id: doc.id,
        revision: detail.document.revision,
        version: detail.version.id,
        page: 1,
        text: 'Reviewed correction: 18 Nm.',
      },
      edit,
    );
    assert.equal(
      (await call('documents.page', { id: doc.id, version: version.id, page: 1 }, read)).text,
      version.pages[0]!.text,
    );
    await wait(
      (
        await call(
          'documents.publish',
          {
            id: doc.id,
            revision: corrected.revision,
            version: detail.version.id,
            acknowledge: true,
          },
          edit,
        )
      ).id,
    );
    assert.equal(
      (await call('documents.read', { id: doc.id }, read)).version.id,
      detail.version.id,
    );
    const active = detail.version.id;
    detail = await call('documents.read', { id: doc.id }, edit);
    // Fail one derivative copy, then retry: immutable original/current search must survive.
    const derivative = copies.find((asset) => asset.mime === 'audio/wav')!;
    app.s.storage.copy = async (from, to, signal) => {
      if (from === derivative.object_key)
        throw new AppError('STORAGE_UNAVAILABLE', 'Учебный отказ хранилища.', 503);
      return copy(from, to, signal);
    };
    const failed = await call(
      'documents.revise',
      { id: doc.id, revision: detail.document.revision, version: active },
      edit,
    );
    await wait(failed.id, 'failed');
    assert.equal((await call('documents.read', { id: doc.id }, read)).version.id, active);
    app.s.storage.copy = copy;
    await wait((await call('jobs.retry', { id: failed.id }, edit)).id);
    const recovered = await call('documents.read', { id: doc.id }, edit);
    assert.equal(recovered.version.state, 'review');
    assert.equal(
      (
        await run(() =>
          app.s.db.query('SELECT id FROM assets WHERE tenant_id=$1 AND version_id=$2', [
            tenant.id,
            recovered.version.id,
          ]),
        )
      ).length,
      3,
      'Retry reuses copied assets without duplicates.',
    );
    // A current review blocks another clone before any copy is made.
    await assert.rejects(
      call(
        'documents.revise',
        { id: doc.id, revision: recovered.document.revision, version: active },
        edit,
      ),
      /уже есть версия/u,
    );
    await wait(
      (
        await call(
          'documents.publish',
          {
            id: doc.id,
            revision: recovered.document.revision,
            version: recovered.version.id,
            acknowledge: true,
          },
          edit,
        )
      ).id,
    );
    const beforeQuota = await call('documents.read', { id: doc.id }, edit);
    const settings = await call('settings.read', {});
    await call('settings.save', { revision: settings.revision, settings: { storageBytes: 1 } });
    await assert.rejects(
      call(
        'documents.revise',
        { id: doc.id, revision: beforeQuota.document.revision, version: recovered.version.id },
        edit,
      ),
      /Недостаточно места/u,
    );
    const afterQuota = await call('documents.read', { id: doc.id }, edit);
    assert.equal(afterQuota.versions.length, beforeQuota.versions.length);
    assert.equal(afterQuota.document.revision, beforeQuota.document.revision);
  } finally {
    app.s.storage.copy = copy;
    for (const key of await app.s.storage.keys('tenants/' + tenant.id + '/'))
      await app.s.storage.remove(key);
    await app.s.db.query("DELETE FROM pgboss.job WHERE data->>'tenant'=$1", [tenant.id]);
    await run(() => app.s.db.query('DELETE FROM usage_ledger WHERE tenant_id=$1', [tenant.id]));
    await app.s.db.query('DELETE FROM gc_objects WHERE object_key LIKE $1', [
      'tenants/' + tenant.id + '/%',
    ]);
    await app.s.db.query('DELETE FROM tenants WHERE id=$1', [tenant.id]);
    for (const id of accounts) await app.s.db.query('DELETE FROM users WHERE id=$1', [id]);
  }
}
