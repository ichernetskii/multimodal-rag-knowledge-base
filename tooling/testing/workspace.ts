import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { isolatedDatabase } from './isolated-database.ts';
import { createHttpServer } from '../../server/src/interfaces/http/server.ts';
import { createClientServer } from '../../client/scripts/gateway.ts';
import {
  terminal,
  type ActionName,
  type ActionInputs,
  type ActionResults,
} from '../../server/src/contracts/public.ts';

await isolatedDatabase(async (app, config) => {
  const apiServer = createHttpServer(app);
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const apiAddress = apiServer.address();
  if (!apiAddress || typeof apiAddress === 'string') throw new Error('API address is unavailable.');
  const client = createClientServer({ apiUrl: 'http://127.0.0.1:' + apiAddress.port });
  await new Promise<void>((resolve) => client.listen(0, '127.0.0.1', resolve));
  const address = client.address();
  if (!address || typeof address === 'string') throw new Error('Client address is unavailable.');
  config.origin = 'http://127.0.0.1:' + address.port;
  const shutdown = new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  const session = await app.s.identity.login(
    'admin',
    'local-development-only',
    'isolated-workspace',
  );
  const user = session.user;
  const call = <N extends ActionName>(action: N, input: ActionInputs[N]) =>
    app.execute(action, input as Record<string, unknown>, user) as Promise<ActionResults[N]>;
  const wait = async (id: string, failure = false) => {
    for (const deadline = Date.now() + 180000; Date.now() < deadline;) {
      const job = await call('jobs.read', { id });
      if (terminal.has(job.status)) {
        if (!failure && job.status !== 'complete')
          throw new Error(
            JSON.stringify({ status: job.status, code: job.error, message: job.result.message }),
          );
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('Fixture processing timed out.');
  };
  try {
    await app.s.queue.runWorker();
    await call('tenants.create', { name: 'Empty company B' });
    const members = [];
    for (const role of ['admin', 'editor', 'user'] as const)
      members.push(
        await call('users.create', {
          login: 'qa-' + role,
          password: 'verification-password',
          role,
        }),
      );
    const base = await call('collections.save', {
      name: 'Sample materials',
      grants: members.map((member) => ({
        subject: member.id,
        access: member.role === 'editor' ? ('edit' as const) : ('read' as const),
      })),
    });
    const profiles = await call('models.list', {}),
      whisper = profiles.find((profile) => profile.provider === 'whisper')!;
    await call('models.save', { profile: { ...whisper, enabled: true } });
    const settings = await call('settings.read', {});
    await call('settings.save', {
      revision: settings.revision,
      settings: { transcriptionProfile: whisper.id },
    });
    const upload = async (name: string, bytes: Buffer, publish: boolean, failure = false) => {
      const session = await call('uploads.create', {
        name,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        collection: base.id,
      });
      for (let offset = 0; offset < bytes.length; offset += session.partBytes)
        await app.s.db.tenant(user.tenant, user.id, () =>
          app.documents.uploadPart(
            user,
            session.id,
            offset,
            bytes.subarray(offset, offset + session.partBytes),
          ),
        );
      const material = await call('documents.upload', { upload: session.id });
      if (!material.job) throw new Error('Extraction job is missing.');
      await wait(material.job.id, failure);
      if (publish) {
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
      }
      console.log(
        'Fixture: ' +
          name +
          (publish ? ' · published' : failure ? ' · processing failed' : ' · awaiting review'),
      );
    };
    const manifest = JSON.parse(
      await readFile(
        new URL('../../examples/knowledge-base/manifest.json', import.meta.url),
        'utf8',
      ),
    ) as { materials: { path: string; kind: string }[] };
    for (const material of manifest.materials)
      await upload(
        basename(material.path),
        await readFile(new URL('../../examples/knowledge-base/' + material.path, import.meta.url)),
        material.path !== 'pdf/scan.pdf',
      );
    const reference = Array.from(
      { length: 120 },
      (_, index) =>
        `${index + 1}. Universal reference guide section Check the request number, document validity, and responsible team member. Record the verification in the log. Do not replace measurements with assumptions.

${[15, 17, 78, 102].includes(index) ? 'Code P-204 requests an additional review. This code is used in the sample.' : 'Follow the approved procedure and keep supporting evidence.'}\n\n`,
    ).join('\n');
    await mkdir('.artifacts/verification', { recursive: true });
    await writeFile('.artifacts/verification/long-reference.txt', reference);
    await upload('Long reference guide.txt', Buffer.from(reference), false);
    await upload('Damaged file.pdf', Buffer.from('Invalid PDF fixture.'), false, true);
    await call('secrets.save', {
      id: 'qa-disabled',
      label: 'Disabled sample key',
      provider: 'google',
      enabled: false,
      value: 'qa-only-invalid-key-value',
      revision: 0,
    });
    console.log('QA workspace ready: ' + config.origin);
    console.log(
      'Operator: admin / local-development-only; company roles: qa-admin, qa-editor, qa-user / verification-password.',
    );
    console.log('Stop with Ctrl+C to remove only this test database and S3 bucket.');
    await shutdown;
  } finally {
    client.closeAllConnections();
    apiServer.closeAllConnections();
    await new Promise<void>((resolve) => client.close(() => resolve()));
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  }
});
