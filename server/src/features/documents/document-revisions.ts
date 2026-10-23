import { createHash, randomUUID } from 'node:crypto';
import type { Services } from '../../application/services.js';
import type { DocumentRecord, Job, Principal } from '../../contracts/public.js';
import type { Asset, StoredVersion } from '../../domain/entities.js';
import { requireValue } from '../../shared/errors.js';
import { revision, string, type Input } from '../../shared/input.js';
import type { Documents } from './saas-documents.js';

const derivedId = (version: string, asset: string) => {
  const hash = createHash('sha256')
    .update(version + ':' + asset)
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
};

/** A correction starts a separate review version and never reruns OCR, ASR or paid inference. */
export class DocumentRevisions {
  constructor(
    private readonly s: Services,
    private readonly documents: Documents,
  ) {}

  async create(user: Principal, input: Input) {
    let copiedKey = '';
    try {
      return await this.s.db.transaction(async () => {
        await this.s.db.lock('access');
        await this.s.db.lock('document-review:' + string(input, 'id'));
        const document = await this.documents.document(user, string(input, 'id'), true);
        revision(input, document);
        const source = await this.s.db.get<StoredVersion>('version', string(input, 'version'));
        requireValue(
          source?.document === document.id && source.state === 'ready',
          'VERSION_NOT_READY',
          'Corrections can be created from a processed, published version.',
          409,
        );
        requireValue(
          !(await this.s.db.count('version', "document_id=$2 AND version_state<>'ready'", [
            document.id,
          ])),
          'REVIEW_PENDING',
          'This material already has a version being processed or reviewed. Finish it before creating corrections.',
          409,
        );
        const original = await this.documents.asset(user, document.id, source.id);
        const version: StoredVersion = {
          id: randomUUID(),
          document: document.id,
          name: source.name,
          hash: source.hash,
          created: Date.now(),
          pages: [],
          state: 'pending',
          acknowledged: false,
          signature: '',
          original: randomUUID(),
        };
        await this.s.db.put('version', version);
        copiedKey = `tenants/${user.tenant}/objects/${version.original}`;
        await this.copyAsset(document, version, original, version.original);
        document.revision++;
        await this.s.db.put('document', document);
        const job = await this.s.queue.create(
          'document',
          {
            document: document.id,
            version: version.id,
            sourceVersion: source.id,
            stage: 'revise',
          },
          user,
        );
        await this.s.identity.audit(
          user.id,
          'documents.revise',
          document.id + ':' + source.id + ':' + version.id,
        );
        await this.s.db.invalidate();
        return job;
      });
    } catch (error) {
      if (copiedKey)
        await this.s.db.query('INSERT INTO gc_objects VALUES($1,$2) ON CONFLICT DO NOTHING', [
          copiedKey,
          Date.now(),
        ]);
      throw error;
    }
  }

  private async copyAsset(
    document: DocumentRecord,
    version: StoredVersion,
    source: Asset,
    id: string,
    signal?: AbortSignal,
    fence?: () => Promise<unknown>,
  ) {
    const tenant = this.s.db.tenantId;
    const existing = await this.s.db.query(
      'SELECT 1 FROM assets WHERE tenant_id=$1 AND id=$2 AND version_id=$3',
      [tenant, id, version.id],
    );
    if (existing.length) return;
    const key = `tenants/${tenant}/objects/${id}`;
    try {
      await this.s.db.transaction(async () => {
        await this.s.db.lock('storage');
        const [usage] = await this.s.db.query<{ bytes: string }>(
          "SELECT (coalesce((SELECT sum(bytes) FROM assets WHERE tenant_id=$1),0)+coalesce((SELECT sum((body->>'bytes')::bigint) FROM uploads WHERE tenant_id=$1 AND body->>'state'<>'consumed'),0)) AS bytes",
          [tenant],
        );
        const settings = await this.s.identity.settings();
        requireValue(
          Number(usage?.bytes ?? 0) + Number(source.bytes) <= settings.storageBytes,
          'STORAGE_QUOTA',
          "Not enough storage for a correction version. Increase the company's storage limit.",
          429,
        );
        signal?.throwIfAborted();
        await this.s.storage.copy(source.object_key, key, signal);
        signal?.throwIfAborted();
        await fence?.();
        requireValue(
          await this.s.db.get('version', version.id),
          'SOURCE_DELETED',
          'Correction version deleted.',
          409,
        );
        await this.s.db.query('INSERT INTO assets VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
          tenant,
          id,
          document.id,
          version.id,
          key,
          source.name,
          source.mime,
          source.bytes,
          source.sha256,
          Date.now(),
        ]);
      });
    } catch (error) {
      await this.s.db.query('INSERT INTO gc_objects VALUES($1,$2) ON CONFLICT DO NOTHING', [
        key,
        Date.now(),
      ]);
      throw error;
    }
  }

  async process(job: Job, user: Principal, signal: AbortSignal, attempt: string) {
    const document = await this.documents.document(user, String(job.payload.document), true);
    const version = await this.s.db.get<StoredVersion>('version', String(job.payload.version));
    const source = await this.s.db.get<StoredVersion>('version', String(job.payload.sourceVersion));
    requireValue(
      version?.document === document.id &&
        source?.document === document.id &&
        source.state === 'ready',
      'SOURCE_DELETED',
      'The source version for corrections is unavailable.',
      409,
    );
    const assets = await this.s.db.query<Asset>(
      'SELECT * FROM assets WHERE tenant_id=$1 AND version_id=$2 ORDER BY id',
      [user.tenant, source.id],
    );
    const identifiers = new Map(
      assets.map((asset) => [
        asset.id,
        asset.id === source.original ? version.original : derivedId(version.id, asset.id),
      ]),
    );
    for (const [index, asset] of assets.entries()) {
      signal.throwIfAborted();
      await this.documents.document(
        await this.s.identity.current(user.id, user.tenant),
        document.id,
        true,
      );
      await this.copyAsset(document, version, asset, identifiers.get(asset.id)!, signal, () =>
        this.s.queue.update(
          job.id,
          {
            status: 'extracting',
            result: {
              copied: index + 1,
              total: assets.length,
              message: `Copying files for corrections: ${index + 1} of ${assets.length}. Recognition is not run again`,
            },
          },
          attempt,
        ),
      );
    }
    const reference = (id: string | undefined) => {
      if (!id) return undefined;
      const mapped = identifiers.get(id);
      requireValue(
        mapped,
        'ASSET_MISSING',
        'The original file or media fragment for corrections was not found.',
        409,
      );
      return mapped;
    };
    const pages = structuredClone(source.pages).map((page) => ({
      ...page,
      ...(page.media
        ? {
            media: {
              ...page.media,
              asset: reference(page.media.asset),
              preview: reference(page.media.preview),
            },
          }
        : {}),
    }));
    await this.s.db.transaction(async () => {
      await this.s.db.lock('access');
      await this.s.db.lock('document-review:' + document.id);
      await this.documents.document(
        await this.s.identity.current(user.id, user.tenant),
        document.id,
        true,
      );
      await this.s.queue.update(
        job.id,
        {
          status: 'complete',
          result: { document: document.id, version: version.id, reviewRequired: true },
        },
        attempt,
      );
      requireValue(
        await this.s.db.get('version', version.id),
        'SOURCE_DELETED',
        'Correction version deleted.',
        409,
      );
      await this.s.db.put('version', { ...version, pages, state: 'review' });
      await this.s.db.invalidate();
    });
  }
}
