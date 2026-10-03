import { secp256k1 } from '@noble/curves/secp256k1';

/**
 * DER `(r, s)` → the 65-byte `r || s || v` an EVM signature is. Pure, and
 * deliberately free of NestJS, of any custody client and of any chain SDK.
 *
 * ## Why this file exists before the backend that needs it most
 *
 * `AwsKmsSecp256k1Signer` is **not** built yet: the KMS client is
 * `useValue: null` and `@aws-sdk/client-kms` is not a dependency, so a second
 * unwireable backend would be weight that never comes off. But KMS's
 * `Sign` returns a DER `(r, s)` and **no `v`**, and recovering that `v` is
 * the one non-obvious piece — the half that would otherwise be
 * rewritten from memory, at the wrong time, by whoever does wire KMS up. So
 * the derivation ships now, vector-pinned, and the client does not.
 *
 * `Secp256k1EnvSigner` uses it too: @noble hands back a `recovery` field on the
 * signature it just produced, and this file re-derives it instead of trusting
 * it, so both backends take the same road and one suite covers both.
 *
 * ## The three steps, and the third is a real recovery
 *
 *  1. parse DER → `r`, `s`;
 *  2. if `s > n/2`, set `s = n - s` (low-s) — **which flips the recovery bit**,
 *     so it happens BEFORE the search rather than after it;
 *  3. try `v = 27` and `v = 28`, recover a public key from each, and keep the
 *     one equal to the key we already hold. If neither matches, the signature
 *     is not over the digest you think — throw.
 *
 * There is no fourth step in which a default is chosen. A guessed `v` produces
 * a signature that recovers a stranger's address, and the chain answers
 * `SignerIsNotVerifier` for a key that was perfectly good — which sends the
 * investigation to the registry instead of to this function.
 *
 * ## The identity compared is a public key, not an address
 *
 * The obvious approach compares addresses. An address is `keccak(pubkey)[12:]`, a
 * lossy function of the thing actually being compared, so comparing the points
 * is strictly stronger — and it keeps `keccak` out of a file that lives outside
 * `src/modules/chains/`, where ESLint's `CHAIN_SDK_BAN` forbids `viem`. Every
 * caller has the public key: the env backend derives it, and KMS's
 * `GetPublicKey` returns it. Rendering that key as an EIP-55 address is
 * `EvmVerifierRegistryService.addressOf`'s job, on the other side of the chain
 * boundary where `keccak` is allowed.
 */

/** The secp256k1 group order, checked against the curve library by its test. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * `secp256k1n / 2` — the low-`s` bound, written as `src/Types.sol` in assay-evm
 * writes it. `chains/evm/secp256k1-recover.ts` holds the same number for the verify
 * direction; `recovery-id.spec.ts` pins the two together, because a low-s bound
 * that differs between the signer and the verifier is a signature this platform
 * produces and then refuses.
 */
export const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** Uncompressed SEC1: `0x04 || X || Y`. Nothing else is accepted as an identity. */
const UNCOMPRESSED_PUBLIC_KEY_LENGTH = 65;

export function deriveRecoveryId(
  der: Uint8Array,
  digest: Uint8Array,
  publicKey: Uint8Array,
): 27 | 28 {
  assertUncompressed(publicKey);
  const normalised = lowS(secp256k1.Signature.fromDER(der));

  for (const recovery of [0, 1] as const) {
    if (recovers(normalised, digest, recovery, publicKey)) {
      return (27 + recovery) as 27 | 28;
    }
  }

  // No default, and no "pick 27". The message names the only thing that can be
  // wrong here and does not quote the digest, the signature or the key.
  throw new Error(
    'the DER signature is not over the digest you think: neither v recovers the expected key',
  );
}

/** The full 65-byte `r || s || v`, low-s normalised. */
export function derToRawSignature(
  der: Uint8Array,
  digest: Uint8Array,
  publicKey: Uint8Array,
): Uint8Array {
  const normalised = lowS(secp256k1.Signature.fromDER(der));
  // Derived from the NORMALISED signature, never from the DER as supplied:
  // flipping `s` flips the bit, and a `v` taken before the flip recovers a
  // different key.
  const v = deriveRecoveryId(normalised.toDERRawBytes(), digest, publicKey);

  const raw = new Uint8Array(65);
  raw.set(toBytes32(normalised.r), 0);
  raw.set(toBytes32(normalised.s), 32);
  raw[64] = v;
  return raw;
}

// ── Internals ──────────────────────────────────────────────────────────────

/** `s > n/2` is the other valid encoding of the same signature. Fold it. */
function lowS(signature: InstanceType<typeof secp256k1.Signature>) {
  return signature.s > SECP256K1_HALF_N
    ? new secp256k1.Signature(signature.r, SECP256K1_N - signature.s)
    : signature;
}

function recovers(
  signature: InstanceType<typeof secp256k1.Signature>,
  digest: Uint8Array,
  recovery: 0 | 1,
  publicKey: Uint8Array,
): boolean {
  let recovered: Uint8Array;
  try {
    recovered = signature.addRecoveryBit(recovery).recoverPublicKey(digest).toRawBytes(false);
  } catch {
    // A recovery id that yields no point on the curve. An answer, not a fault.
    return false;
  }
  return Buffer.compare(recovered, publicKey) === 0;
}

function assertUncompressed(publicKey: Uint8Array): void {
  if (publicKey.length !== UNCOMPRESSED_PUBLIC_KEY_LENGTH) {
    // A compressed (33-byte) key recovers to the same point but never compares
    // equal to the 65 bytes derived here, so without this it would surface as
    // "neither v matched" — which sends the reader looking for a signature bug
    // when what happened was an encoding mismatch.
    throw new Error(`an uncompressed secp256k1 public key is 65 bytes; got ${publicKey.length}`);
  }
}

/** Big-endian, left-padded to 32 bytes. A short `r` shifts every later byte. */
function toBytes32(value: bigint): Uint8Array {
  return Uint8Array.from(Buffer.from(value.toString(16).padStart(64, '0'), 'hex'));
}
