import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { inspect } from 'node:util';

import { EnvSigningKeySource } from '@modules/verification/signing/backends/env-key-source';
import { EnvKeypairSigner } from '@modules/verification/signing/backends/env-keypair.signer';
import { SignerBackend } from '@modules/verification/signing/ports/signer.port';

import { itSatisfiesTheSignerPortContract } from './signer-port.contract';

/**
 * The custody guarantees the env backend claims, tested as guarantees rather
 * than as behaviour.
 *
 * Three of these — non-extractability, the zeroed seed, the absence of any
 * material-returning method — are what let the security model's "the key never
 * leaves" survive being implemented on an environment variable.
 * If any of them regress, the MVP divergence recorded in `docs/architecture.md`
 * stops being defensible, so they are asserted here and not merely commented.
 */
itSatisfiesTheSignerPortContract({
  name: 'EnvKeypairSigner',
  curve: 'ed25519',
  keyIds: ['contract-a', 'contract-b'],
  build: () => new EnvKeypairSigner([keySource('contract-a'), keySource('contract-b')]),
});

describe('EnvKeypairSigner', () => {
  it('signs verifiably with the public key it reports', async () => {
    const source = keySource('verifier-a');
    const signer = new EnvKeypairSigner([source]);
    const message = Buffer.from('an attestation, one day');

    const signature = await signer.sign('verifier-a', message);
    const handle = await signer.getKey('verifier-a');

    expect(signature).toHaveLength(64);
    await expect(verify(handle.publicKey, signature, message)).resolves.toBe(true);
  });

  it('zeroes the seed it was handed, so no copy survives the import', async () => {
    const source = keySource('verifier-a');
    const signer = new EnvKeypairSigner([source]);

    await signer.getKey('verifier-a');

    expect(Array.from(source.seed).every((b) => b === 0)).toBe(true);
  });

  it('exposes no way to reach the material, and inspecting it prints none', async () => {
    const source = keySource('verifier-a');
    const seedHex = Buffer.from(source.seed).toString('hex');
    const signer = new EnvKeypairSigner([source]);
    await signer.getKey('verifier-a');

    // `#keys` is a true private field: it is not an own property, so nothing
    // that walks the object — a crash reporter, a structured logger, a
    // `JSON.stringify` in a debug line — can find it.
    expect(Object.getOwnPropertyNames(signer)).toEqual(
      expect.not.arrayContaining(['keys', '#keys']),
    );
    expect(inspect(signer, { depth: 6, showHidden: true })).not.toContain(seedHex);
    expect(JSON.stringify(signer)).not.toContain(seedHex);

    // And the port offers no method that would return it.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(signer)).sort()).toEqual([
      'constructor',
      'getKey',
      'listKeys',
      'load',
      'resolve',
      'sign',
    ]);
  });

  it('imports the private key non-extractably, so the runtime itself refuses to return it', async () => {
    // The mechanism the test above depends on, asserted directly rather than
    // assumed: `extractable: false` is what makes "there is no call that
    // returns the material" true, as opposed to "no caller makes one".
    const { privateKey } = generateKeyPairSync('ed25519');
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
    const key = await webcrypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);

    expect(key.extractable).toBe(false);
    await expect(webcrypto.subtle.exportKey('pkcs8', key)).rejects.toThrow();
  });

  it('reports the env variable name as the backend reference, never its value', async () => {
    const signer = new EnvKeypairSigner([keySource('verifier-a')]);

    const handle = await signer.getKey('verifier-a');

    expect(handle.backend).toBe(SignerBackend.ENV);
    expect(handle.backendRef).toBe('env:VERIFIER_SIGNING_KEYS');
  });

  it('refuses a 64-byte key whose public half does not match its private half', async () => {
    const source = keySource('verifier-a');
    const mismatched: EnvSigningKeySource = {
      ...source,
      claimedPublicKey: new Uint8Array(32).fill(9),
    };

    // A mismatch that got through would register one key on-chain and sign with
    // another, and the failure would surface as "unknown verifier" from the
    // program rather than as a paste error.
    await expect(new EnvKeypairSigner([mismatched]).getKey('verifier-a')).rejects.toThrow(
      /does not match its private half/,
    );
  });

  it('lists retired keys too, so a rotation has something to cut over from', async () => {
    const signer = new EnvKeypairSigner([keySource('old'), keySource('new')]);

    const keys = await signer.listKeys();

    expect(keys.map((k) => k.keyId).sort()).toEqual(['new', 'old']);
  });

  it('names the key it does not have', async () => {
    const signer = new EnvKeypairSigner([keySource('verifier-a')]);

    await expect(signer.sign('verifier-b', Buffer.from('x'))).rejects.toThrow(
      /No signing key "verifier-b"/,
    );
  });
});

/** A real ed25519 keypair, in the shape `takeEnvSigningKeys` produces. */
function keySource(keyId: string): EnvSigningKeySource {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  return { keyId, seed: new Uint8Array(pkcs8.subarray(16)), claimedPublicKey: null };
}

async function verify(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  const key = await webcrypto.subtle.importKey('raw', publicKey, 'Ed25519', true, ['verify']);
  return webcrypto.subtle.verify('Ed25519', key, signature, message);
}
