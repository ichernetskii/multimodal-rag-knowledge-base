import { randomUUID } from 'node:crypto';
import type {
  AICredential,
  CredentialAudit,
  CredentialProvider,
  ModelProfile,
  Principal,
} from '../../contracts/public.js';
import type { Database } from '../../infrastructure/database/postgres.js';
import type { Identity } from '../identity/saas-identity.js';
import { number, revision, string, type Input } from '../../shared/input.js';
import { requireValue } from '../../shared/errors.js';
import { CredentialCipher, type SealedCredential } from './credential-crypto.js';
type Stored = Omit<AICredential, 'uses'> & SealedCredential;
const metadata = `id,label,provider,enabled,revision,created::float8,updated::float8,credential_references(id)::integer AS uses`;
/** Platform-scoped, deliberately outside tenant resource tables and tenant backups. */
export class CredentialVault {
  private readonly cipher: CredentialCipher;
  constructor(
    private readonly db: Database,
    private readonly identity: Identity,
    master: string,
  ) {
    this.cipher = new CredentialCipher(master);
  }
  async lock() {
    await this.db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('platform-ai-credentials',0))",
    );
  }
  async list(user: Principal): Promise<AICredential[]> {
    this.identity.operator(user);
    return this.db.query<AICredential>(
      `SELECT ${metadata} FROM ai_credentials ORDER BY label,id LIMIT 200`,
    );
  }
  private async audit(
    user: Principal,
    id: string,
    action: CredentialAudit['action'],
    enabled: boolean,
  ) {
    await this.db.query(
      'INSERT INTO credential_audits(id,credential,action,enabled,actor,actor_login,created) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(), id, action, enabled, user.id, user.login, Date.now()],
    );
  }
  async save(user: Principal, p: Input): Promise<AICredential> {
    this.identity.operator(user);
    const id = string(p, 'id', '', 64),
      label = string(p, 'label', '', 120).trim(),
      provider = string(p, 'provider') as CredentialProvider;
    requireValue(
      /^[a-z][a-z0-9_-]{0,63}$/u.test(id) &&
        label.length > 0 &&
        ['google', 'anthropic', 'openai-compatible'].includes(provider) &&
        typeof p.enabled === 'boolean',
      'INVALID_INPUT',
      'Укажите идентификатор, название, поставщика и состояние ключа.',
    );
    const value = p.value;
    requireValue(
      value === undefined || (typeof value === 'string' && /^[\x21-\x7e]{8,8192}$/u.test(value)),
      'INVALID_CREDENTIAL',
      'Ключ должен содержать от 8 до 8192 печатных ASCII-символов без пробелов и переносов строк.',
    );
    return this.db.transaction(async () => {
      await this.lock();
      const [old] = await this.db.query<Stored>(
        'SELECT * FROM ai_credentials WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (old) {
        revision(p, old);
        requireValue(
          provider === old.provider,
          'CREDENTIAL_PROVIDER_IMMUTABLE',
          'Для другого поставщика создайте отдельный ключ.',
          409,
        );
      } else {
        requireValue(
          number(p, 'revision') === 0,
          'REVISION_CONFLICT',
          'Ключ был удалён. Обновите список.',
          409,
        );
        requireValue(typeof value === 'string', 'CREDENTIAL_REQUIRED', 'Введите API-ключ.');
        const [count] = await this.db.query<{ count: string }>(
          'SELECT count(*) FROM ai_credentials',
        );
        requireValue(
          Number(count?.count) < 200,
          'CREDENTIAL_LIMIT',
          'Можно сохранить не более 200 ключей платформы.',
          409,
        );
      }
      const sealed = typeof value === 'string' ? this.cipher.seal(id, provider, value) : old!;
      const [sequence] = await this.db.query<{ revision: number }>(
        "SELECT nextval('credential_revision_seq') AS revision",
      );
      const nextRevision = Number(sequence!.revision),
        now = Date.now(),
        enabled = p.enabled as boolean;
      await this.db.query(
        'INSERT INTO ai_credentials(id,label,provider,enabled,revision,created,updated,ciphertext,nonce,tag) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET label=excluded.label,enabled=excluded.enabled,revision=excluded.revision,updated=excluded.updated,ciphertext=excluded.ciphertext,nonce=excluded.nonce,tag=excluded.tag',
        [
          id,
          label,
          provider,
          enabled,
          nextRevision,
          old?.created ?? now,
          now,
          sealed.ciphertext,
          sealed.nonce,
          sealed.tag,
        ],
      );
      await this.audit(
        user,
        id,
        !old
          ? 'created'
          : typeof value === 'string'
            ? 'rotated'
            : enabled !== old.enabled
              ? enabled
                ? 'enabled'
                : 'disabled'
              : 'updated',
        enabled,
      );
      const [result] = await this.db.query<AICredential>(
        `SELECT ${metadata} FROM ai_credentials WHERE id=$1`,
        [id],
      );
      return result!;
    });
  }
  async remove(user: Principal, p: Input) {
    this.identity.operator(user);
    const id = string(p, 'id', '', 64);
    return this.db.transaction(async () => {
      await this.lock();
      const [old] = await this.db.query<Stored>(
        'SELECT * FROM ai_credentials WHERE id=$1 FOR UPDATE',
        [id],
      );
      requireValue(old, 'NOT_FOUND', 'Ключ не найден.', 404);
      revision(p, old);
      const [uses] = await this.db.query<{ count: string }>(
        'SELECT credential_references($1) AS count',
        [id],
      );
      requireValue(
        Number(uses?.count) === 0,
        'CREDENTIAL_IN_USE',
        'Ключ используется в профилях моделей. Сначала выберите для них другой ключ. Для немедленной остановки новых вызовов отключите ключ.',
        409,
      );
      await this.db.query('DELETE FROM ai_credentials WHERE id=$1', [id]);
      await this.audit(user, id, 'deleted', false);
      return { ok: true };
    });
  }
  async history(user: Principal, p: Input) {
    this.identity.operator(user);
    const page = number(p, 'page', 1),
      pageSize = number(p, 'pageSize', 25);
    requireValue(
      Number.isSafeInteger(page) &&
        page >= 1 &&
        page <= 100000 &&
        Number.isSafeInteger(pageSize) &&
        pageSize >= 1 &&
        pageSize <= 100,
      'INVALID_INPUT',
      'Некорректная страница журнала.',
    );
    const items = await this.db.query<CredentialAudit>(
      'SELECT id,credential,action,enabled,actor,actor_login AS "actorLogin",created::float8 FROM credential_audits ORDER BY created DESC,id LIMIT $1 OFFSET $2',
      [pageSize, (page - 1) * pageSize],
    );
    const [row] = await this.db.query<{ count: string }>('SELECT count(*) FROM credential_audits');
    return { items, total: Number(row?.count ?? 0), page, pageSize };
  }
  /** Validate a profile reference while holding the shared writer lock. Never decrypt here. */
  async validateReference(p: ModelProfile) {
    if (!p.secretRef) {
      requireValue(
        !p.enabled || !['google', 'anthropic'].includes(p.provider),
        'CREDENTIAL_REQUIRED',
        'Выберите включённый API-ключ владельца платформы.',
        409,
      );
      return;
    }
    const [row] = await this.db.query<{ provider: string; enabled: boolean }>(
      'SELECT provider,enabled FROM ai_credentials WHERE id=$1',
      [p.secretRef],
    );
    requireValue(
      row && row.provider === p.provider,
      'CREDENTIAL_REQUIRED',
      'Выберите сохранённый ключ того же поставщика.',
      409,
    );
    requireValue(
      !p.enabled || row.enabled,
      'CREDENTIAL_DISABLED',
      'Ключ отключён владельцем платформы.',
      409,
    );
  }
  /** Called just before provider I/O; no plaintext cache and no restart propagation. */
  async resolve(p: ModelProfile): Promise<string> {
    if (!p.secretRef) {
      requireValue(
        !['google', 'anthropic'].includes(p.provider),
        'PROVIDER_SECRET_MISSING',
        'API-ключ не настроен. Владелец платформы может добавить его в разделе «AI-подключения и ключи».',
        503,
      );
      return '';
    }
    const [row] = await this.db.query<Stored>('SELECT * FROM ai_credentials WHERE id=$1', [
      p.secretRef,
    ]);
    requireValue(
      row && row.provider === p.provider,
      'PROVIDER_SECRET_MISSING',
      'API-ключ не настроен. Обратитесь к владельцу платформы.',
      503,
    );
    requireValue(
      row.enabled,
      'CREDENTIAL_DISABLED',
      'API-ключ отключён владельцем платформы.',
      503,
    );
    return this.cipher.open(row.id, row.provider, row);
  }
}
