import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Application } from '../src/application/application.js';
import type {
  ActionName,
  ActionInputs,
  ActionResults,
  DocumentRecord,
  Principal,
} from '../src/contracts/public.js';
import type { StoredVersion } from '../src/domain/entities.js';
import { terminal } from '../src/contracts/public.js';

export async function materialTextScenario(app: Application, owner: Principal) {
  let captions = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === '/api/show') {
      res.end(JSON.stringify({ capabilities: ['completion', 'vision'] }));
      return;
    }
    captions++;
    res.end(
      JSON.stringify({
        message: { content: 'AX-100 service label: E-42, torque 12 Nm.' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 100,
        eval_count: 20,
      }) + '\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = 'http://127.0.0.1:' + address.port,
    previous = process.env.AI_ALLOWED_ENDPOINTS;
  process.env.AI_ALLOWED_ENDPOINTS = [previous, endpoint].filter(Boolean).join(',');
  const tenant = await app.s.identity.createTenant(
    owner.id,
    'Media text transition ' + randomUUID(),
  );
  const user = await app.s.identity.current(owner.id, tenant.id);
  const run = <T>(work: () => Promise<T>) => app.s.db.tenant(user.tenant, user.id, work);
  const call = <N extends ActionName>(action: N, input: ActionInputs[N]) =>
    app.execute(action, input as Record<string, unknown>, user) as Promise<ActionResults[N]>;
  const wait = async (id: string, success = true) => {
    for (let until = Date.now() + 20000; Date.now() < until;) {
      const job = await call('jobs.read', { id });
      if (terminal.has(job.status)) {
        assert.equal(job.status, success ? 'complete' : 'failed', JSON.stringify(job));
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Media text transition timed out.');
  };
  try {
    const profiles = await call('models.list', {});
    const native = profiles.find((p) => p.role === 'embedding' && p.enabled)!;
    const caption = await call('models.save', {
      profile: {
        ...profiles.find((p) => p.provider === 'ollama' && p.role === 'generation')!,
        id: randomUUID(),
        revision: 0,
        endpoint,
        enabled: true,
      },
    });
    let settings = await call('settings.read', {});
    await call('settings.save', {
      revision: settings.revision,
      settings: { generationProfile: caption.id },
    });
    const base = await call('collections.save', { name: 'Media', grants: [] });
    const bytes = await readFile(
      new URL('../../examples/knowledge-base/media/label.png', import.meta.url),
    );
    const add = async () => {
      const doc: DocumentRecord = {
        id: randomUUID(),
        name: 'native-photo.png',
        collection: base.id,
        conversation: '',
        owner: user.id,
        revision: 1,
        activeVersion: randomUUID(),
        state: 'published',
      };
      const version: StoredVersion = {
        id: doc.activeVersion,
        document: doc.id,
        name: doc.name,
        hash: createHash('sha256').update(bytes).digest('hex'),
        created: Date.now(),
        pages: [
          {
            number: 1,
            text: doc.name,
            method: 'vision',
            sections: [],
            warnings: [],
            media: { kind: 'image', asset: randomUUID() },
          },
        ],
        state: 'ready',
        acknowledged: true,
        signature: '',
        original: '',
      };
      version.original = version.pages[0]!.media!.asset!;
      await run(async () => {
        await app.s.db.put('document', doc);
        await app.s.db.put('version', version);
        await app.documents.storeAsset(
          doc,
          version,
          version.original,
          bytes,
          'image/png',
          doc.name,
        );
        await app.s.db.invalidate();
      });
      return { doc, version };
    };
    const first = await add();
    await wait(
      (
        await call('documents.publish', {
          id: first.doc.id,
          revision: 1,
          version: first.version.id,
          acknowledge: true,
        })
      ).id,
    );
    assert.equal(captions, 0);
    const active = await run(() => app.documents.activeIndex());
    const textModel = await call('models.save', {
      profile: { ...native, id: randomUUID(), revision: 0, name: 'Text search A', input: ['text'] },
    });
    await wait((await call('indexes.build', { profile: textModel.id })).id);
    assert.equal(captions, 1);
    const detail = await call('documents.read', { id: first.doc.id });
    const preparedPage = await call('documents.page', {
      id: first.doc.id,
      version: detail.version.id,
      page: 1,
    });
    assert.match(preparedPage.text, /12 Nm/);
    assert.equal(preparedPage.preparedText?.profile, caption.id);
    const raw = await run(() => app.s.db.get<StoredVersion>('version', first.version.id));
    assert.equal(raw?.pages[0]!.text, first.doc.name);
    assert.equal(raw?.hash, first.version.hash);
    assert.equal((await run(() => app.documents.activeIndex())).id, active.id);
    const another = await call('models.save', {
      profile: { ...textModel, id: randomUUID(), revision: 0, name: 'Text search B' },
    });
    await wait((await call('indexes.build', { profile: another.id })).id);
    assert.equal(captions, 1, 'Another text embedding model reuses the description.');
    await add();
    const noVision = await call('models.save', {
      profile: {
        ...profiles.find((p) => p.role === 'generation' && p.provider === 'test')!,
        id: randomUUID(),
        revision: 0,
        input: ['text'],
        enabled: true,
      },
    });
    settings = await call('settings.read', {});
    await call('settings.save', {
      revision: settings.revision,
      settings: { generationProfile: noVision.id },
    });
    const failed = await wait((await call('indexes.build', { profile: another.id })).id, false);
    assert.equal(failed.error, 'DESCRIPTION_MODEL_REQUIRED');
    assert.equal((await run(() => app.documents.activeIndex())).id, active.id);
    settings = await call('settings.read', {});
    await call('settings.save', {
      revision: settings.revision,
      settings: { generationProfile: caption.id },
    });
    const built = await wait((await call('indexes.build', { profile: another.id })).id);
    await call('indexes.activate', { id: String(built.result.index) });
    assert.equal(captions, 2);
    assert.equal((await run(() => app.documents.activeIndex())).profile, another.id);
    assert.ok((await call('search', { question: 'E-42 12 Nm' })).length);
    settings = await call('settings.read', {});
    await call('settings.save', {
      revision: settings.revision,
      settings: { generationProfile: noVision.id, answerMaxImages: 0 },
    });
    const conversation = await call('conversations.create', { title: 'Caption fallback' });
    const answer = await call('answers.create', {
      conversation: conversation.id,
      revision: conversation.revision,
      question: 'E-42 12 Nm',
      scope: { collection: base.id },
      attachments: [],
      idempotencyKey: randomUUID(),
    });
    await wait(answer.job.id);
    const history = await call('conversations.read', { id: conversation.id });
    assert.equal(
      history.turns[0]!.sources.length,
      2,
      'Binary-media limits must not discard prepared text sources.',
    );
    assert.ok(history.turns[0]!.sources.every((source) => source.text.includes('12 Nm')));
  } finally {
    for (const key of await app.s.storage.keys('tenants/' + tenant.id + '/'))
      await app.s.storage.remove(key);
    await app.s.db.query("DELETE FROM pgboss.job WHERE data->>'tenant'=$1", [tenant.id]);
    await run(() => app.s.db.query('DELETE FROM usage_ledger WHERE tenant_id=$1', [tenant.id]));
    await app.s.db.query('DELETE FROM tenants WHERE id=$1', [tenant.id]);
    if (previous === undefined) delete process.env.AI_ALLOWED_ENDPOINTS;
    else process.env.AI_ALLOWED_ENDPOINTS = previous;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
