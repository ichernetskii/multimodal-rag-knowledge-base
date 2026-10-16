import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Application } from '../src/application/application.js';
import type {
  ActionInputs,
  ActionName,
  ActionResults,
  Principal,
} from '../src/contracts/public.js';

export async function attachmentScenario(
  app: Application,
  user: Principal,
  wait: (id: string) => Promise<unknown>,
) {
  const call = <N extends ActionName>(action: N, input: ActionInputs[N]) =>
    app.execute(action, input as Record<string, unknown>, user) as Promise<ActionResults[N]>;
  const conversation = await call('conversations.create', { title: 'Long private attachment' });
  const embedding = (await call('models.list', {})).find(
    (profile) => profile.enabled && profile.role === 'embedding',
  )!;
  // This disposable tenant verifies context selection, not the default rate window.
  await call('models.save', {
    profile: { ...embedding, requestsPerMinute: 1000, tokensPerMinute: 10_000_000 },
  });
  const text =
    Array.from(
      { length: 100 },
      (_, index) =>
        `## Ordinary section ${index + 1}\n\n${'Record the result in the log and follow the documented procedure. '.repeat(20)}\n\n`,
    ).join('') +
    '\n## Final reference\n\nZX-901 torque limit is 37 Nm. Use the calibrated instrument.\n';
  const bytes = Buffer.from(text);
  const upload = await call('uploads.create', {
    conversation: conversation.id,
    name: 'long-private-reference.txt',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  for (let offset = 0; offset < bytes.length; offset += upload.partBytes)
    await app.s.db.tenant(user.tenant, user.id, () =>
      app.documents.uploadPart(
        user,
        upload.id,
        offset,
        bytes.subarray(offset, offset + upload.partBytes),
      ),
    );
  const material = await call('documents.upload', { upload: upload.id });
  assert.ok(material.job);
  await wait(material.job.id);
  const detail = await call('documents.read', { id: material.document.id });
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
  assert.ok(
    !(await call('documents.list', {})).items.some((item) => item.id === material.document.id),
    'Private attachments must not appear in the shared material catalog.',
  );
  const answer = await call('answers.create', {
    conversation: conversation.id,
    revision: conversation.revision,
    question: 'What is the ZX-901 torque limit?',
    attachments: [material.document.id],
    idempotencyKey: randomUUID(),
  });
  await wait(answer.job.id);
  const history = await call('conversations.read', { id: conversation.id });
  assert.ok(
    history.turns[0]!.sources.some(
      (source) => source.document === material.document.id && source.text.includes('37 Nm'),
    ),
    'The selected attachment must contribute the relevant late fragment, not its full first page.',
  );
  assert.ok(
    history.turns[0]!.sources.every((source) => source.text.length < 10000),
    'Answer context remains bounded by indexed fragments.',
  );
}
