import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CredentialCipher } from '../src/features/models/credential-crypto.js';
import { loadDeployment } from '../src/config/saas-config.js';
const cipher = new CredentialCipher('a1'.repeat(32));
void test('encrypted credentials use fresh nonces and authenticate the alias and provider', () => {
  const value = 'synthetic-api-key-never-a-real-provider-key',
    sealed = cipher.seal('google', 'google', value),
    second = cipher.seal('google', 'google', value);
  assert.equal(cipher.open('google', 'google', sealed), value);
  assert.notDeepEqual(sealed.nonce, second.nonce);
  assert.notDeepEqual(sealed.ciphertext, second.ciphertext);
  assert.ok(!sealed.ciphertext.includes(Buffer.from(value)));
  for (const [id, provider] of [
    ['other', 'google'],
    ['google', 'anthropic'],
  ] as const)
    assert.throws(() => cipher.open(id, provider, sealed), /Не удалось открыть ключ/u);
});
void test('tampering or the wrong master key fails without revealing plaintext or crypto details', () => {
  const sealed = cipher.seal('google', 'google', 'synthetic-sensitive-value');
  const damaged = Buffer.from(sealed.ciphertext);
  damaged[0] = damaged[0]! ^ 1;
  assert.throws(
    () => cipher.open('google', 'google', { ...sealed, ciphertext: damaged }),
    /Не удалось открыть ключ/u,
  );
  assert.throws(
    () => new CredentialCipher('b2'.repeat(32)).open('google', 'google', sealed),
    /Не удалось открыть ключ/u,
  );
});
void test('a missing, malformed or zero encryption key is rejected in development as well as production', () => {
  for (const key of ['', '0'.repeat(64), 'bad-key']) {
    assert.throws(() => new CredentialCipher(key), /APP_ENCRYPTION_KEY/);
    assert.throws(
      () => loadDeployment({ NODE_ENV: 'development', APP_ENCRYPTION_KEY: key }),
      /APP_ENCRYPTION_KEY/,
    );
  }
});
