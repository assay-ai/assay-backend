import {
  resetEnvSigningKeyCacheForTests,
  takeEnvSigningKeys,
} from '@modules/verification/signing/backends/env-key-source';
import { VERIFIER_SIGNING_KEYS_ENV } from '@modules/verification/signing/signing.constants';
import { takeEvmSigningKeys } from '@modules/verification/signing/backends/evm-key-source';
import { EVM_VERIFIER_SIGNING_KEYS_ENV } from '@modules/verification/signing/signing.constants';

// The parsed result is cached per process; each case must start clean.
beforeEach(() => resetEnvSigningKeyCacheForTests());

/**
 * Key custody, at the unit level: key material must not survive boot in
 * the environment, and must not escape through an error message on the way.
 *
 * The whole-session grep in `scripts/verifier-key/leak-scan.sh` is the other
 * half of that check. This is the half that fails a pull request.
 */
describe('takeEnvSigningKeys', () => {
  const SEED = 'a'.repeat(64);

  it('removes the variable from the environment it read', () => {
    const env = { [VERIFIER_SIGNING_KEYS_ENV]: keysJson(SEED) } as NodeJS.ProcessEnv;

    takeEnvSigningKeys(env);

    expect(env[VERIFIER_SIGNING_KEYS_ENV]).toBeUndefined();
    expect(Object.keys(env)).not.toContain(VERIFIER_SIGNING_KEYS_ENV);
  });

  it('removes it even when parsing then fails', () => {
    // The run where a debugger gets attached is the run where the config was
    // wrong. Leaving the material behind for that run is the worst case.
    const env = { [VERIFIER_SIGNING_KEYS_ENV]: `{"secretKey":"${SEED}"` } as NodeJS.ProcessEnv;

    expect(() => takeEnvSigningKeys(env)).toThrow(/not valid JSON/);
    expect(env[VERIFIER_SIGNING_KEYS_ENV]).toBeUndefined();
  });

  it('never quotes the material it failed to parse', () => {
    // Node's own JSON.parse message includes a slice of the input. Re-raising
    // it would print the key into the boot log — so the message is replaced,
    // and this test is what stops somebody "improving" the error later.
    const env = { [VERIFIER_SIGNING_KEYS_ENV]: `[{"keyId":"k","secretKey":"${SEED}"` };

    try {
      takeEnvSigningKeys(env as NodeJS.ProcessEnv);
      fail('expected a parse failure');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(SEED);
      expect(String((error as Error).message)).not.toContain(SEED.slice(0, 16));
    }
  });

  it('never quotes the material when a key is the wrong length', () => {
    const short = 'bc'.repeat(8);
    const env = { [VERIFIER_SIGNING_KEYS_ENV]: keysJson(short) };

    try {
      takeEnvSigningKeys(env as NodeJS.ProcessEnv);
      fail('expected a length failure');
    } catch (error) {
      expect((error as Error).message).toContain('expected 32 (seed) or 64');
      expect((error as Error).message).not.toContain(short);
    }
  });

  it('reads a 32-byte seed', () => {
    const [key] = takeEnvSigningKeys({ [VERIFIER_SIGNING_KEYS_ENV]: keysJson(SEED) });

    expect(key.keyId).toBe('verifier-test');
    expect(key.seed).toHaveLength(32);
    expect(key.claimedPublicKey).toBeNull();
  });

  it('splits the solana-keygen 64-byte form into seed and claimed public half', () => {
    const expanded = `${SEED}${'b'.repeat(64)}`;

    const [key] = takeEnvSigningKeys({ [VERIFIER_SIGNING_KEYS_ENV]: keysJson(expanded) });

    expect(Buffer.from(key.seed).toString('hex')).toBe(SEED);
    expect(Buffer.from(key.claimedPublicKey as Uint8Array).toString('hex')).toBe('b'.repeat(64));
  });

  it('accepts a solana-keygen byte array pasted straight in', () => {
    const bytes = Array.from({ length: 64 }, (_, i) => i);
    const env = {
      [VERIFIER_SIGNING_KEYS_ENV]: JSON.stringify([{ keyId: 'k', secretKey: bytes }]),
    };

    const [key] = takeEnvSigningKeys(env);

    expect(Array.from(key.seed)).toEqual(bytes.slice(0, 32));
  });

  it('refuses two keys with the same id', () => {
    const env = {
      [VERIFIER_SIGNING_KEYS_ENV]: JSON.stringify([
        { keyId: 'same', secretKey: SEED },
        { keyId: 'same', secretKey: 'c'.repeat(64) },
      ]),
    };

    expect(() => takeEnvSigningKeys(env)).toThrow(/duplicate keyId/);
  });

  it('treats an unset variable as no keys rather than as a failure', () => {
    // A process that never signs must still boot. Refusing here would make the
    // signing module un-importable anywhere it is not used.
    expect(takeEnvSigningKeys({})).toEqual([]);
  });
});

function keysJson(secretKey: string): string {
  return JSON.stringify([{ keyId: 'verifier-test', secretKey }]);
}

/**
 * `SERVICE_TYPE=all` runs all six bootstraps in ONE process, so six Nest
 * containers each resolve `EVM_SIGNING_KEY_SOURCES`. The cache in
 * `takeOnceFromEnv` exists for exactly that reason — its own comment records an
 * earlier incident where the second consumer got an empty list and every slash
 * failed with nothing logged.
 *
 * `Secp256k1EnvSigner.importKey` then zeroes `source.secretKey` in a `finally`,
 * deliberately, so the transport copy does not stay resident after the signer
 * has taken its own. But the object it zeroes is the CACHED one, so the second
 * container is handed 32 zero bytes and refuses to boot with
 *
 *   key "…" is not a valid secp256k1 scalar
 *
 * which names the key rather than the sharing, and appears only when several
 * service types share a process — never on the cluster, where each pod runs one.
 */
describe('takeEvmSigningKeys — one process, several containers', () => {
  const SCALAR = 'c7d6ca52ddc37a561f7b720ab0aba9f31f390374b07df83775b51ad14fb04294';
  const entry = (s: string) =>
    JSON.stringify([{ keyId: 'verifier-evm-2026-09', chainId: 'eip155:46630', secretKey: s }]);

  it('gives each caller material it may zero without blinding the next one', () => {
    const env = { [EVM_VERIFIER_SIGNING_KEYS_ENV]: entry(SCALAR) } as NodeJS.ProcessEnv;

    const first = takeEvmSigningKeys(env);
    // Exactly what Secp256k1EnvSigner.importKey does once it has copied the
    // scalar into the signer.
    first[0].secretKey.fill(0);

    const second = takeEvmSigningKeys(env);
    expect(second[0].secretKey.some((b) => b !== 0)).toBe(true);
    expect(Buffer.from(second[0].secretKey).toString('hex')).toBe(SCALAR);
  });
});
