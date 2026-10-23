import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { CredentialProvider } from '../../contracts/public.js';
import { AppError, requireValue } from '../../shared/errors.js';
export interface SealedCredential {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
}
/** Domain-separated from backup signatures; the master key never lives in PostgreSQL. */
export class CredentialCipher {
  private readonly key: Buffer;
  constructor(master: string) {
    requireValue(
      /^[a-f0-9]{64}$/iu.test(master) && !/^0+$/u.test(master),
      'INVALID_CONFIG',
      'APP_ENCRYPTION_KEY must contain 32 random bytes encoded as hex.',
    );
    this.key = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(master, 'hex'),
        Buffer.from('local-rag'),
        Buffer.from('ai-credential-encryption-v1'),
        32,
      ),
    );
  }
  private aad(id: string, provider: CredentialProvider) {
    return Buffer.from(`local-rag/ai-key/v1\0${id}\0${provider}`);
  }
  seal(id: string, provider: CredentialProvider, value: string): SealedCredential {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(this.aad(id, provider));
    return {
      ciphertext: Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]),
      nonce,
      tag: cipher.getAuthTag(),
    };
  }
  open(id: string, provider: CredentialProvider, value: SealedCredential): string {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, value.nonce);
      decipher.setAAD(this.aad(id, provider));
      decipher.setAuthTag(value.tag);
      const plaintext = Buffer.concat([decipher.update(value.ciphertext), decipher.final()]);
      try {
        return plaintext.toString('utf8');
      } finally {
        plaintext.fill(0);
      }
    } catch {
      throw new AppError(
        'CREDENTIAL_DECRYPTION_FAILED',
        "Could not decrypt the key. Check this installation's APP_ENCRYPTION_KEY or replace the key in the admin interface.",
        503,
      );
    }
  }
}
