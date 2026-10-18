import { randomBytes } from 'node:crypto';

import {
  credentialAad,
  Kek,
  openCredentialSet,
  sealCredentialSet,
  valueHint,
} from '@modules/provider/credentials/credential-vault.crypto';
import {
  CREDENTIAL_VAULT_KEKS_ENV,
  takeVaultKeks,
} from '@modules/provider/credentials/credential-vault.keys';
import { resetEnvSigningKeyCacheForTests } from '@modules/verification/signing/backends/env-key-source';

const kek: Kek = { keyId: 'k1', key: randomBytes(32) };
const keks = new Map([[kek.keyId, kek]]);
const aad = credentialAad('org', 'binding', 'https://x.test');
const headers = [{ name: 'Authorization', value: 'Bearer sk-example-1234567890abcdef' }];

describe('credential vault crypto', () => {
  it('round-trips a header set', () => {
    expect(openCredentialSet(sealCredentialSet(headers, kek, aad), keks, aad)).toEqual(headers);
  });

  it('refuses a different AAD', () => {
    const sealed = sealCredentialSet(headers, kek, aad);
    expect(() =>
      openCredentialSet(sealed, keks, credentialAad('org', 'binding', 'https://y.test')),
    ).toThrow();
  });

  it('refuses a tampered ciphertext', () => {
    const sealed = sealCredentialSet(headers, kek, aad);
    sealed.ciphertext[0] ^= 0xff;
    expect(() => openCredentialSet(sealed, keks, aad)).toThrow();
  });

  it('refuses a tampered wrapped DEK', () => {
    const sealed = sealCredentialSet(headers, kek, aad);
    sealed.wrappedDek[sealed.wrappedDek.length - 1] ^= 0x01;
    expect(() => openCredentialSet(sealed, keks, aad)).toThrow();
  });

  it('refuses an unknown KEK id', () => {
    const sealed = sealCredentialSet(headers, kek, aad);
    expect(() => openCredentialSet(sealed, new Map(), aad)).toThrow();
  });

  it('uses a fresh DEK and IVs on every seal', () => {
    const a = sealCredentialSet(headers, kek, aad);
    const b = sealCredentialSet(headers, kek, aad);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.dekIv.equals(b.dekIv)).toBe(false);
  });

  it('hints the last 4 characters of long values only', () => {
    expect(valueHint('sk-example-1234567890abcdef')).toBe('cdef');
    expect(valueHint('short')).toBeNull();
  });

  it('builds the versioned AAD', () => {
    expect(credentialAad('o', 'b', 'https://x.test')).toBe(
      'assay/binding-credentials/v1/o/b/https://x.test',
    );
  });
});

describe('takeVaultKeks', () => {
  beforeEach(() => resetEnvSigningKeyCacheForTests());
  afterAll(() => resetEnvSigningKeyCacheForTests());

  it('loads the first key as active and deletes the variable', () => {
    const hex = randomBytes(32).toString('hex');
    const env: NodeJS.ProcessEnv = {
      [CREDENTIAL_VAULT_KEKS_ENV]: JSON.stringify([
        { keyId: 'k1', key: hex },
        { keyId: 'k0', key: randomBytes(32).toString('hex') },
      ]),
    };
    const loaded = takeVaultKeks(env);
    expect(loaded.active?.keyId).toBe('k1');
    expect(loaded.active?.key.toString('hex')).toBe(hex);
    expect(loaded.byId.size).toBe(2);
    expect(env[CREDENTIAL_VAULT_KEKS_ENV]).toBeUndefined();
  });

  it('has no active key when the variable is unset', () => {
    expect(takeVaultKeks({}).active).toBeNull();
  });

  it('rejects a 31-byte key without echoing it', () => {
    const hex = randomBytes(31).toString('hex');
    const env: NodeJS.ProcessEnv = {
      [CREDENTIAL_VAULT_KEKS_ENV]: JSON.stringify([{ keyId: 'k1', key: hex }]),
    };
    let message = '';
    try {
      takeVaultKeks(env);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(hex);
    expect(env[CREDENTIAL_VAULT_KEKS_ENV]).toBeUndefined();
  });

  it.each(['00', 'ff', '7a'])('rejects a key whose every byte is %s', (byte) => {
    const env: NodeJS.ProcessEnv = {
      [CREDENTIAL_VAULT_KEKS_ENV]: JSON.stringify([{ keyId: 'k1', key: byte.repeat(32) }]),
    };
    expect(() => takeVaultKeks(env)).toThrow(/placeholder/);
  });

  it('fails the boot in production when no key is configured', () => {
    expect(() => takeVaultKeks({ NODE_ENV: 'production' })).toThrow(
      /CREDENTIAL_VAULT_KEKS must be set in production/,
    );
  });

  it('boots without a key outside production', () => {
    expect(takeVaultKeks({ NODE_ENV: 'development' }).active).toBeNull();
  });

  it('boots in production with a key', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      [CREDENTIAL_VAULT_KEKS_ENV]: JSON.stringify([
        { keyId: 'k1', key: randomBytes(32).toString('hex') },
      ]),
    };
    expect(takeVaultKeks(env).active?.keyId).toBe('k1');
  });

  it('rejects malformed JSON without echoing it', () => {
    expect(() => takeVaultKeks({ [CREDENTIAL_VAULT_KEKS_ENV]: '[{"keyId":"secret-ish' })).toThrow(
      /not valid JSON/,
    );
  });
});
