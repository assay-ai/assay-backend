import { inspect } from 'node:util';

import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak256, toBytes } from 'viem';

import { EvmSigningKeySource } from '@modules/verification/signing/backends/evm-key-source';
import { Secp256k1EnvSigner } from '@modules/verification/signing/backends/secp256k1-env.signer';
import { SECP256K1_HALF_N } from '@modules/verification/signing/backends/recovery-id';
import { SignerBackend } from '@modules/verification/signing/ports/signer.port';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';

import { itSatisfiesTheSignerPortContract } from './signer-port.contract';

/**
 * The secp256k1 env backend, run through the SAME contract every other
 * `SignerPort` is run through, plus the four things the shared contract cannot
 * express because they are curve-specific.
 *
 * The shared suite is what makes "swapping in KMS is a new class and one line
 * of wiring" a claim with evidence behind it. It could not accept a secp256k1
 * backend before multichain support — it asserted 64-byte signatures and 32-byte public keys —
 * and generalising it rather than writing a second suite is what keeps the two
 * backends comparable.
 */
const SCALAR_A = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const SCALAR_B = '8da4ef21b864d2cc526dbdb2a120bd2874c36c9d0a1fb7f8c63d7f7a8b6a1c05';

itSatisfiesTheSignerPortContract({
  name: 'Secp256k1EnvSigner',
  curve: 'secp256k1',
  keyIds: ['contract-a', 'contract-b'],
  build: () =>
    new Secp256k1EnvSigner([source('contract-a', SCALAR_A), source('contract-b', SCALAR_B)]),
});

describe('Secp256k1EnvSigner', () => {
  it('produces a signature whose recovered key is the handle key', async () => {
    // The port is bytes-in-bytes-out and cannot say this; the chain can only
    // use the key if it does. Verified with @noble against the ADDRESS as the
    // contract computes it, not against the signer's own opinion.
    const signer = new Secp256k1EnvSigner([source('verifier-evm-2026-09', SCALAR_A)]);
    const digest = toBytes(keccak256(toBytes('a slash attestation, one day')));

    const signature = await signer.sign('verifier-evm-2026-09', digest);
    const handle = await signer.getKey('verifier-evm-2026-09');

    expect(signature).toHaveLength(65);
    expect(addressOf(recover(signature, digest))).toBe(addressOf(handle.publicKey));
  });

  it('emits a low-s signature, which is the only half the contract accepts', async () => {
    // `ECDSA.tryRecover` refuses `s > n/2`. A signer that emitted the high half
    // would produce signatures the chain rejects — and, before it got there,
    // a second valid 65-byte string over the same voucher, which breaks the
    // off-chain idempotency keyed on `payment_intents.voucher_signature`.
    const signer = new Secp256k1EnvSigner([source('k', SCALAR_A)]);

    for (let i = 0; i < 32; i += 1) {
      const digest = toBytes(keccak256(toBytes(`low-s sweep ${i}`)));
      const signature = await signer.sign('k', digest);
      const s = BigInt(`0x${Buffer.from(signature.subarray(32, 64)).toString('hex')}`);

      expect(s).toBeGreaterThan(0n);
      expect(s).toBeLessThanOrEqual(SECP256K1_HALF_N);
      expect([27, 28]).toContain(signature[64]);
      expect(recover(signature, digest)).toEqual(
        secp256k1.getPublicKey(toBytes(`0x${SCALAR_A}`), false),
      );
    }
  });

  it('refuses to sign anything that is not a 32-byte digest', async () => {
    // A signer that hashed for its caller would sign a value the caller never
    // computed. For EIP-712 the digest IS the binding — domain, primary type,
    // every field — so re-hashing one produces a signature over a preimage with
    // no domain in it, which is a signature valid on the wrong chain.
    const signer = new Secp256k1EnvSigner([source('k', SCALAR_A)]);

    await expect(signer.sign('k', Buffer.from('an attestation, one day'))).rejects.toThrow(
      /32-byte digest/,
    );
    await expect(signer.sign('k', new Uint8Array(31))).rejects.toThrow(/32-byte digest/);
    await expect(signer.sign('k', new Uint8Array(33))).rejects.toThrow(/32-byte digest/);
    // The positive control: 32 bytes is accepted.
    await expect(signer.sign('k', new Uint8Array(32).fill(9))).resolves.toHaveLength(65);
  });

  it('carries the curve and the chain the key was provisioned for', async () => {
    const signer = new Secp256k1EnvSigner([source('k', SCALAR_A)]);

    const handle = await signer.getKey('k');

    expect(handle.curve).toBe('secp256k1');
    expect(handle.chainId).toBe(CHAIN_IDS.ROBINHOOD_TESTNET);
    expect(handle.backend).toBe(SignerBackend.ENV);
    // The locator, never the value.
    expect(handle.backendRef).toBe('env:EVM_VERIFIER_SIGNING_KEYS');
  });

  it('zeroes the scalar it was handed, so no copy survives the import', () => {
    const s = source('k', SCALAR_A);

    new Secp256k1EnvSigner([s]);

    expect(Array.from(s.secretKey).every((b) => b === 0)).toBe(true);
  });

  it('does not print the scalar when inspected', () => {
    const s = source('k', SCALAR_A);
    const signer = new Secp256k1EnvSigner([s]);

    // `#keys` is a true private field: nothing that walks the object — a crash
    // reporter, a structured logger, a `JSON.stringify` in a debug line — finds
    // it. The scalar is resident (WebCrypto has no secp256k1, so it cannot be
    // non-extractable) which is exactly why this is asserted rather than
    // assumed.
    expect(Object.getOwnPropertyNames(signer)).toEqual(
      expect.not.arrayContaining(['keys', '#keys', 'scalar']),
    );
    expect(inspect(signer, { depth: 6, showHidden: true })).not.toContain(SCALAR_A);
  });

  it('refuses a scalar that is not on the curve, without quoting it', () => {
    const zero = {
      keyId: 'k',
      chainId: CHAIN_IDS.ROBINHOOD_TESTNET,
      secretKey: new Uint8Array(32),
    };

    expect(() => new Secp256k1EnvSigner([zero])).toThrow(/not a valid secp256k1 scalar/);
    expect(() => new Secp256k1EnvSigner([zero])).not.toThrow(/00000000/);
  });
});

function source(keyId: string, scalarHex: string): EvmSigningKeySource {
  return {
    keyId,
    chainId: CHAIN_IDS.ROBINHOOD_TESTNET,
    secretKey: Uint8Array.from(Buffer.from(scalarHex, 'hex')),
  };
}

function recover(signature: Uint8Array, digest: Uint8Array): Uint8Array {
  return new secp256k1.Signature(
    BigInt(`0x${Buffer.from(signature.subarray(0, 32)).toString('hex')}`),
    BigInt(`0x${Buffer.from(signature.subarray(32, 64)).toString('hex')}`),
  )
    .addRecoveryBit(signature[64] - 27)
    .recoverPublicKey(digest)
    .toRawBytes(false);
}

/** keccak of the uncompressed key without its `0x04` prefix, last 20 bytes. */
function addressOf(publicKey: Uint8Array): string {
  return `0x${keccak256(publicKey.subarray(1)).slice(-40)}`;
}
