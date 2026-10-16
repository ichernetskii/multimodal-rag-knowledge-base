import type { Services } from '../../application/services.js';
import type { Documents } from '../documents/saas-documents.js';
import type { Conversation, DocumentRecord, Job, Principal } from '../../contracts/public.js';
import type { StoredUpload } from '../../domain/entities.js';

export class Retention {
  constructor(
    private readonly s: Services,
    private readonly documents: Documents,
  ) {}
  async process(job: Job, user: Principal, attempt: string) {
    let removed = 0;
    const known = new Set(
      (
        await this.s.db.query<{ key: string }>(
          "SELECT object_key key FROM assets WHERE tenant_id=$1 UNION SELECT body->>'key' key FROM uploads WHERE tenant_id=$1 AND body->>'state'<>'consumed'",
          [user.tenant],
        )
      ).map((row) => row.key),
    );
    const orphans = (await this.s.storage.keys('tenants/' + user.tenant + '/objects/')).filter(
      (key) => !known.has(key),
    );
    for (let offset = 0; offset < orphans.length; offset += 1000)
      await this.s.db.query(
        'INSERT INTO gc_objects SELECT key,$2 FROM unnest($1::text[]) key ON CONFLICT DO NOTHING',
        [orphans.slice(offset, offset + 1000), Date.now()],
      );
    const pending = await this.s.db.query<{ object_key: string }>(
      'SELECT object_key FROM gc_objects WHERE object_key LIKE $1 AND created<$2 ORDER BY created LIMIT 1000',
      [`tenants/${user.tenant}/%`, Date.now() - 3600000],
    );
    const activeBackup = await this.s.db.count('backup', "body->>'state'='building'");
    if (!activeBackup)
      for (const row of pending) {
        const live = await this.s.db.query(
          'SELECT 1 FROM assets WHERE tenant_id=$1 AND object_key=$2',
          [user.tenant, row.object_key],
        );
        if (!live.length) await this.s.storage.remove(row.object_key);
        await this.s.db.query('DELETE FROM gc_objects WHERE object_key=$1', [row.object_key]);
        removed++;
      }
    const settings = await this.s.identity.settings();
    const uploads = await this.s.db.list<StoredUpload>(
      'upload',
      "(body->>'created')::bigint<$2 AND body->>'state'<>'consumed'",
      [Date.now() - settings.tempHours * 3600000],
      1000,
    );
    for (const upload of uploads) {
      await this.s.storage.abort(upload.key, upload.uploadId).catch(() => {});
      await this.s.storage.remove(upload.key);
      await this.s.db.remove('upload', upload.id);
      removed++;
    }
    await this.s.db.query(
      "DELETE FROM uploads WHERE tenant_id=$1 AND body->>'state'='consumed' AND (body->>'created')::bigint<$2",
      [user.tenant, Date.now() - settings.tempHours * 3600000],
    );
    for (const conversation of await this.s.db.list<Conversation>(
      'conversation',
      "(body->>'updated')::bigint<$2",
      [Date.now() - settings.historyDays * 86400000],
      1000,
    )) {
      for (const doc of await this.s.db.list<DocumentRecord>(
        'document',
        'conversation_id=$2',
        [conversation.id],
        100000,
      ))
        await this.documents.remove({ ...user, id: conversation.owner }, doc.id);
      await this.s.db.remove('conversation', conversation.id);
    }
    await this.s.db.query(
      "DELETE FROM jobs WHERE tenant_id=$1 AND body->>'status' IN('complete','no_info','clarification','cancelled','failed','interrupted') AND (body->>'updated')::bigint<$2",
      [user.tenant, Date.now() - settings.jobDays * 86400000],
    );
    await this.s.db.query(
      "DELETE FROM audits WHERE tenant_id=$1 AND (body->>'created')::bigint<$2",
      [user.tenant, Date.now() - settings.logDays * 86400000],
    );
    await this.s.db.query('DELETE FROM idempotency WHERE tenant_id=$1 AND created<$2', [
      user.tenant,
      Date.now() - settings.jobDays * 86400000,
    ]);
    const backups = await this.s.db.list<{ id: string; created: number; state: string }>(
      'backup',
      "(body->>'created')::bigint<$2 AND body->>'state'<>'building'",
      [Date.now() - settings.backupDays * 86400000],
      1000,
    );
    for (const backup of backups) {
      for (const key of await this.s.storage.keys('backups/' + user.tenant + '/' + backup.id + '/'))
        await this.s.storage.remove(key);
      await this.s.db.remove('backup', backup.id);
    }
    await this.s.db.query('DELETE FROM rate_windows WHERE window_start<$1', [
      Math.floor(Date.now() / 60000) - 60,
    ]);
    await this.s.db.query('DELETE FROM sessions WHERE expires<$1', [Date.now()]);
    await this.s.queue.update(job.id, { status: 'complete', result: { removed } }, attempt);
  }
}
