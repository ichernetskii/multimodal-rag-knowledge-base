import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Application } from '../src/application/application.js';
import type {
  ActionInputs,
  ActionName,
  ActionResults,
  DocumentRecord,
  Principal,
} from '../src/contracts/public.js';
import type { StoredVersion } from '../src/domain/entities.js';

export async function documentReaderScenario(app: Application, operator: Principal) {
  const tenant = await app.s.identity.createTenant(
    operator.id,
    'Reader verification ' + randomUUID(),
  );
  const owner = await app.s.identity.current(operator.id, tenant.id),
    users: string[] = [];
  const call = <N extends ActionName>(action: N, input: ActionInputs[N], principal = owner) =>
    app.execute(action, input as Record<string, unknown>, principal) as Promise<ActionResults[N]>;
  const run = <T>(work: () => Promise<T>) => app.s.db.tenant(tenant.id, owner.id, work);
  try {
    const reader = await call('users.create', {
      login: 'reader-' + randomUUID(),
      password: 'verification-password',
      role: 'user',
    });
    const editor = await call('users.create', {
      login: 'editor-' + randomUUID(),
      password: 'verification-password',
      role: 'editor',
    });
    users.push(reader.id, editor.id);
    const read = await app.s.identity.current(reader.id, tenant.id),
      edit = await app.s.identity.current(editor.id, tenant.id);
    let base = await call('collections.save', {
      name: 'Universal resources',
      grants: [
        { subject: reader.id, access: 'read' },
        { subject: editor.id, access: 'edit' },
      ],
    });
    const put = async (
      name: string,
      state: DocumentRecord['state'],
      content: string,
      created: number,
    ) => {
      const doc: DocumentRecord = {
        id: randomUUID(),
        name,
        collection: base.id,
        conversation: '',
        owner: owner.id,
        revision: 1,
        state,
        activeVersion: '',
      };
      const version: StoredVersion = {
        id: randomUUID(),
        document: doc.id,
        name,
        pages: [{ number: 1, text: content, method: 'text', sections: [], warnings: [] }],
        hash: createHash('sha256').update(content).digest('hex'),
        state: state === 'published' ? 'ready' : 'review',
        created,
        acknowledged: state === 'published',
        signature: '',
        original: randomUUID(),
      };
      if (state === 'published') doc.activeVersion = version.id;
      await run(async () => {
        await app.s.db.put('document', doc);
        await app.s.db.put('version', version);
      });
      return { doc, version };
    };
    const draft = await put('A draft.txt', 'draft', 'unreviewed P-204 draft', 100);
    const published = await put('B published.txt', 'published', 'Reviewed public P-204.', 200);
    const excluded = await put('C excluded.txt', 'excluded', 'not searchable', 300);
    const longText =
      '🔧'.repeat(100) +
      'A'.repeat(180000) +
      '\nP-204: calibration + torque.\nP-204 second occurrence.';
    const large = await put('D reference.txt', 'draft', longText, 400);
    const pending: StoredVersion = {
      ...published.version,
      id: randomUUID(),
      state: 'review',
      acknowledged: false,
      pages: [
        {
          number: 1,
          text: 'Private replacement draft.',
          method: 'text',
          sections: [],
          warnings: [],
        },
      ],
      created: 500,
    };
    await run(() => app.s.db.put('version', pending));
    assert.equal((await call('documents.list', {}, read)).total, 1);
    assert.equal((await call('collections.list', {}, read))[0]!.documentCount, 1);
    assert.equal(
      (await call('documents.read', { id: published.doc.id }, read)).version.id,
      published.version.id,
    );
    assert.equal(
      (await call('documents.read', { id: published.doc.id }, edit)).version.id,
      pending.id,
      'The editor opens the new version awaiting review rather than the old published one.',
    );
    for (const item of [draft, excluded, large]) {
      await assert.rejects(call('documents.read', { id: item.doc.id }, read), /not found/i);
      await assert.rejects(
        call('documents.page', { id: item.doc.id, version: item.version.id, page: 1 }, read),
        /not found/i,
      );
      await assert.rejects(
        call('documents.find', { id: item.doc.id, version: item.version.id, query: 'P-204' }, read),
        /not found/i,
      );
    }
    await assert.rejects(
      call('documents.page', { id: published.doc.id, version: pending.id, page: 1 }, read),
      /not found/i,
    );
    await assert.rejects(
      call(
        'documents.compare',
        { id: published.doc.id, left: published.version.id, right: pending.id },
        read,
      ),
      /not found/i,
    );
    const metadata = await call('documents.read', { id: large.doc.id }, edit);
    assert.equal('pages' in metadata.version, false);
    assert.ok(JSON.stringify(metadata).length < 10000);
    const window = await call(
      'documents.page',
      { id: large.doc.id, version: large.version.id, page: 1, offset: 179900 },
      edit,
    );
    assert.equal(window.totalCharacters, longText.length);
    assert.ok(window.text.includes('P-204'));
    assert.ok(JSON.stringify(window).length < 33000);
    const found = await call(
      'documents.find',
      { id: large.doc.id, version: large.version.id, query: 'p-204', pageSize: 1 },
      edit,
    );
    assert.equal(found.total, 2);
    assert.equal(found.items.length, 1);
    assert.equal(found.items[0]!.offset, longText.indexOf('P-204'));
    const next = await call(
      'documents.find',
      { id: large.doc.id, version: large.version.id, query: 'p-204', page: 2, pageSize: 1 },
      edit,
    );
    assert.ok(next.items[0]!.offset > found.items[0]!.offset);
    const target = found.items[0]!.offset;
    await assert.rejects(
      call(
        'documents.correct',
        {
          id: large.doc.id,
          version: large.version.id,
          revision: large.doc.revision,
          page: 1,
          range: { start: 1, end: 2 },
          text: 'x',
        },
        edit,
      ),
      /cannot split a Unicode character/u,
    );
    await assert.rejects(
      call(
        'documents.correct',
        {
          id: large.doc.id,
          version: large.version.id,
          revision: large.doc.revision,
          page: 1,
          range: { start: 0, end: 2 },
          text: '\ud800',
        },
        edit,
      ),
      /incomplete Unicode character/u,
    );
    const corrected = await call(
      'documents.correct',
      {
        id: large.doc.id,
        version: large.version.id,
        revision: large.doc.revision,
        page: 1,
        range: { start: target, end: target + 5 },
        text: 'Q-901',
      },
      edit,
    );
    const changed = await call(
      'documents.page',
      { id: large.doc.id, version: large.version.id, page: 1, offset: target - 100 },
      edit,
    );
    assert.equal(
      changed.text,
      (longText.slice(0, target) + 'Q-901' + longText.slice(target + 5)).slice(target - 100),
    );
    assert.equal(changed.totalCharacters, longText.length);
    assert.equal(
      (
        await call(
          'documents.find',
          { id: large.doc.id, version: large.version.id, query: 'P-204' },
          edit,
        )
      ).total,
      1,
    );
    await call(
      'documents.correct',
      {
        id: large.doc.id,
        version: large.version.id,
        revision: corrected.revision,
        page: 1,
        range: { start: 0, end: 2 },
        text: '',
      },
      edit,
    );
    const withoutFirstCharacter = await call(
      'documents.page',
      {
        id: large.doc.id,
        version: large.version.id,
        page: 1,
      },
      edit,
    );
    assert.equal(withoutFirstCharacter.totalCharacters, longText.length - 2);
    assert.ok(withoutFirstCharacter.text.startsWith('🔧'.repeat(99) + 'A'));
    const sorted = await call('documents.list', { sort: 'name' }, edit);
    assert.deepEqual(
      sorted.items.map((item) => item.name),
      ['A draft.txt', 'B published.txt', 'C excluded.txt', 'D reference.txt'],
    );
    assert.equal(
      (await call('documents.list', { sort: 'updated' }, edit)).items[0]!.id,
      published.doc.id,
    );
    await put('100% literal.txt', 'draft', 'percent', 600);
    await put('100X literal.txt', 'draft', 'letter', 700);
    assert.equal(
      (await call('documents.list', { query: '100%' })).total,
      1,
      'Filename search treats wildcard characters literally.',
    );
    const connector = await call(
      'sync.save',
      {
        collection: base.id,
        path: 'confidential/local/folder',
        policy: 'keep',
        intervalMinutes: 5,
      },
      edit,
    );
    assert.ok((await call('sync.list', {}, edit)).some((item) => item.id === connector.id));
    base = await call('collections.save', {
      id: base.id,
      revision: base.revision,
      name: base.name,
      grants: [
        { subject: reader.id, access: 'read' },
        { subject: editor.id, access: 'read' },
      ],
    });
    assert.deepEqual(await call('sync.list', {}, edit), []);
    await assert.rejects(call('documents.read', { id: draft.doc.id }, edit), /not found/i);
    assert.equal(
      (await call('documents.read', { id: published.doc.id }, edit)).version.id,
      published.version.id,
    );
    assert.equal((await call('documents.list', {}, edit)).total, 1);
  } finally {
    await app.s.db.query('DELETE FROM tenants WHERE id=$1', [tenant.id]);
    for (const id of users) await app.s.db.query('DELETE FROM users WHERE id=$1', [id]);
  }
}
