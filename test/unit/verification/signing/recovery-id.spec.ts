import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak256, toBytes } from 'viem';

import {
  SECP256K1_HALF_N,
  SECP256K1_N,
  deriveRecoveryId,
  derToRawSignature,
} from '@modules/verification/signing/backends/recovery-id';
import { SECP256K1_HALF_N as EVM_HALF_N } from '@modules/chains/evm/secp256k1-recover';

/**
 * AWS KMS returns a DER-encoded `(r, s)` and **no `v`**. An EVM signature needs
 * 65 bytes. This is the conversion, and it is a real recovery rather than a
 * heuristic: try 27, try 28, keep the one that recovers the key we already
 * hold. If neither matches, the signature is not over the digest you think —
 * fail loudly, never guess.
 *
 * The vector is fixed so this suite tests the derivation and not the generator.
 *
 * ## Why the expected identity is a PUBLIC KEY and not an address
 *
 * A simpler design compares recovered *addresses*. An address is
 * `keccak(pubkey)[12:]` — a lossy function of the thing actually being
 * compared — so comparing points is strictly stronger, and it keeps `keccak`
 * (which in this tree means `viem`) out of a file that lives OUTSIDE
 * `src/modules/chains/` where ESLint's `CHAIN_SDK_BAN` forbids it. Every
 * caller — the env signer, and a future KMS signer whose `GetPublicKey` returns
 * the key — has the public key in hand.
 */
const PRIVATE_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const DIGEST = keccak256(toBytes('x402 recovery-id vector v1'));

const priv = toBytes(PRIVATE_KEY);
const publicKey = secp256k1.getPublicKey(priv, false);

describe('deriveRecoveryId', () => {
  it('picks the v that recovers the signing key, and the other v does not', () => {
    // A SWEEP, not one vector, and that is deliberate. `deriveRecoveryId = () =>
    // 27` passes a single-vector version of this test whenever the vector's own
    // recovery bit happens to be 0 — measured: it does pass, on the fixed
    // digest below. So the assertion is that BOTH answers are actually produced
    // across a deterministic set of digests, which no constant can satisfy.
    const derived = new Set<number>();

    for (let i = 0; i < 16; i += 1) {
      const digest = toBytes(keccak256(toBytes(`x402 recovery-id sweep ${i}`)));
      const der = secp256k1.sign(digest, priv).toDERRawBytes();
      const hex = `0x${Buffer.from(digest).toString('hex')}` as `0x${string}`;

      const v = deriveRecoveryId(der, digest, publicKey);

      expect([27, 28]).toContain(v);
      expect(recoverWith(der, hex, v)).toEqual(publicKey);
      // The control: the OTHER v recovers somebody else, so exactly one answer
      // was ever available for this digest.
      expect(recoverWith(der, hex, v === 27 ? 28 : 27)).not.toEqual(publicKey);
      derived.add(v);
    }

    expect([...derived].sort()).toEqual([27, 28]);
  });

  it('agrees with the recovery bit the signer itself produced', () => {
    // An INDEPENDENT source for the expectation: @noble returns `recovery` on
    // the signature it just made, and this function never sees that field —
    // it is dropped by the DER encoding. Two routes, one answer.
    const signature = secp256k1.sign(toBytes(DIGEST), priv);

    const v = deriveRecoveryId(signature.toDERRawBytes(), toBytes(DIGEST), publicKey);

    expect(v).toBe(27 + signature.recovery);
  });

  it('normalises a high-s signature to low-s AND flips the recovery bit', () => {
    // A KMS may return either half. `s > n/2` must be flipped, and flipping s
    // flips the recovery bit — an implementation that normalises s and keeps
    // the old v produces a signature that recovers a DIFFERENT key, which is
    // exactly the silent failure this function exists to prevent.
    const low = secp256k1.sign(toBytes(DIGEST), priv);
    expect(low.hasHighS()).toBe(false);
    const highS = new secp256k1.Signature(low.r, SECP256K1_N - low.s);
    expect(highS.hasHighS()).toBe(true);

    // `deriveRecoveryId` folds `s` ITSELF, so a direct caller handing it the
    // high-s form gets the low-s form's bit. Without that internal fold the
    // search finds `low.recovery ^ 1`, which is the "normalised s, kept the old
    // v" defect — and `derToRawSignature` alone cannot see it, because it hands
    // down an already-folded signature.
    expect(deriveRecoveryId(highS.toDERRawBytes(), toBytes(DIGEST), publicKey)).toBe(
      27 + low.recovery,
    );

    const raw = derToRawSignature(highS.toDERRawBytes(), toBytes(DIGEST), publicKey);

    expect(raw).toHaveLength(65);
    const s = bigIntFrom(raw.subarray(32, 64));
    expect(s).toBeLessThanOrEqual(SECP256K1_HALF_N);
    expect(s).toBe(low.s);
    // The bit flipped, and this is the direction it flips in: the high-s form
    // that was handed in recovers under `low.recovery ^ 1`, and folding it back
    // to low-s restores the ORIGINAL signature, whose bit is `low.recovery`. An
    // implementation that normalises `s` and keeps the `v` it read off the
    // input emits the other one — so this line, plus the control below, is what
    // refutes it.
    expect(raw[64]).toBe(27 + low.recovery);
    expect(recoverWith(highS.toDERRawBytes(), DIGEST, 27 + (low.recovery ^ 1))).toEqual(publicKey);
    expect(recoverWith(raw, DIGEST, raw[64], 'raw')).toEqual(publicKey);
    expect(recoverWith(raw, DIGEST, raw[64] === 27 ? 28 : 27, 'raw')).not.toEqual(publicKey);
  });

  it('emits r and s left-padded to 32 bytes each', () => {
    // A short `r` — one with a leading zero byte — shifts every later byte if
    // it is copied in unpadded, which silently corrupts `s` and `v` together.
    const { der, digest, r } = shortRVector();
    expect(r < 1n << 248n).toBe(true);

    const raw = derToRawSignature(der, digest, publicKey);

    expect(raw).toHaveLength(65);
    expect(raw[0]).toBe(0);
    expect(bigIntFrom(raw.subarray(0, 32))).toBe(r);
    expect(recoverWith(raw, `0x${Buffer.from(digest).toString('hex')}`, raw[64], 'raw')).toEqual(
      publicKey,
    );
  });

  it('throws — never guesses — when neither v recovers the expected key', () => {
    const stranger = secp256k1.utils.randomPrivateKey();
    const der = secp256k1.sign(toBytes(DIGEST), stranger).toDERRawBytes();

    expect(() => deriveRecoveryId(der, toBytes(DIGEST), publicKey)).toThrow(/not over the digest/i);
    expect(() => derToRawSignature(der, toBytes(DIGEST), publicKey)).toThrow(
      /not over the digest/i,
    );
  });

  it('refuses a public key that is not a 65-byte uncompressed SEC1 key', () => {
    // The compressed form recovers to the same point but never compares equal
    // to the 65 bytes this function derives, so it would look like "neither v
    // matched" — a confusing error for a caller who passed the right key in
    // the wrong encoding.
    const der = secp256k1.sign(toBytes(DIGEST), priv).toDERRawBytes();
    const compressed = secp256k1.getPublicKey(priv, true);

    expect(() => deriveRecoveryId(der, toBytes(DIGEST), compressed)).toThrow(/65/);
  });

  it('pins secp256k1n and its half to the values the EVM adapter already uses', () => {
    // The independent source: `Types.sol`'s low-s bound, which
    // `chains/evm/secp256k1-recover.ts` transcribed first. Two files, one
    // number — and `n` is checked against the curve library rather than
    // against itself.
    expect(SECP256K1_HALF_N).toBe(EVM_HALF_N);
    expect(SECP256K1_N).toBe(secp256k1.CURVE.n);
    expect(SECP256K1_HALF_N).toBe(SECP256K1_N >> 1n);
  });
});

function bigIntFrom(bytes: Uint8Array): bigint {
  return BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
}

/** Recover from a DER blob (or a 65-byte raw) with a chosen `v`. */
function recoverWith(
  signature: Uint8Array,
  digest: `0x${string}`,
  v: number,
  form: 'der' | 'raw' = 'der',
): Uint8Array | null {
  const parsed =
    form === 'der'
      ? secp256k1.Signature.fromDER(signature)
      : new secp256k1.Signature(
          bigIntFrom(signature.subarray(0, 32)),
          bigIntFrom(signature.subarray(32, 64)),
        );
  try {
    return parsed
      .addRecoveryBit(v - 27)
      .recoverPublicKey(toBytes(digest))
      .toRawBytes(false);
  } catch {
    return null;
  }
}

/** A deterministic signature whose `r` has a leading zero byte. */
function shortRVector(): { der: Uint8Array; digest: Uint8Array; r: bigint } {
  for (let i = 0; i < 4096; i += 1) {
    const digest = toBytes(keccak256(toBytes(`x402 short-r probe ${i}`)));
    const signature = secp256k1.sign(digest, priv);
    if (signature.r < 1n << 248n) {
      return { der: signature.toDERRawBytes(), digest, r: signature.r };
    }
  }
  throw new Error('no short-r vector found in 4096 probes');
}
