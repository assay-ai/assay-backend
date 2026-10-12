import { secp256k1 } from '@noble/curves/secp256k1';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { VerificationErrors } from '../../errors/verification.errors';
import { EVM_SIGNING_KEY_SOURCES, ENV_SIGNER_WARNING } from '../signing.constants';
import { SignerBackend, SignerKeyHandle, SignerPort } from '../ports/signer.port';
import { EvmSigningKeySource } from './evm-key-source';
import { derToRawSignature } from './recovery-id';

/** `ecrecover` takes a 32-byte digest and nothing else. */
const DIGEST_LENGTH = 32;

/**
 * `SignerPort` over secp256k1 key material supplied through the environment.
 *
 * The EVM half of the same MVP custody divergence `EnvKeypairSigner` documents:
 * the security model puts the key in a KMS, `docs/architecture.md`
 * §"Signing Keys" records why it is an environment variable for now, and the
 * conditions are unchanged by the curve.
 *
 * ## Three things it keeps from the ed25519 backend, and one it cannot
 *
 * Kept: the variable is **deleted at boot** (`evm-key-source.ts`, through the
 * same `takeOnceFromEnv`); every intermediate buffer is **zeroed**; no parse
 * error quotes its input; there is no method that returns material, and every
 * method is `async`.
 *
 * **Not kept — and this is worth being honest about — is non-extractability.**
 * `EnvKeypairSigner` imports its seed as a `CryptoKey` with
 * `extractable: false`, after which there is no API in the process that returns
 * the material. WebCrypto has no secp256k1, and Node's ECDSA surface hashes the
 * message it is given rather than signing a digest, so neither can be used
 * here: the scalar stays resident as a `bigint` in a `#private` field for the
 * life of the process. A heap dump reaches it. That gap is not closed by
 * anything at this layer — it is closed by KMS, and it is the strongest single
 * argument in this file for `AwsKmsSecp256k1Signer`, whose only genuinely
 * non-obvious piece (`recovery-id.ts`) already exists.
 *
 * ## Why a leak of it still does not lose user money
 *
 * The verifier key does not move funds. Every money-moving path in
 * `X402Escrow` is authorised by `msg.sender == buyer`, by a buyer's EIP-712
 * signature, or by a registered verifier's attestation **plus a 72-hour
 * timelock and `MAX_SLASH_CAP_BPS`** — and enrolling a verifier is the admin
 * Ledger's, a key this codebase never sees. A stolen verifier key buys a
 * proposal that a human has three days to cancel, bounded above by the cap; it
 * buys nothing at all against a buyer's escrow balance, and `withdraw()` is
 * `msg.sender`-only and pays `msg.sender`, so the owner — later, a Ledger — is
 * the only party who can take money out.
 *
 * ## Two shapes that differ from ed25519, both forced by the curve
 *
 * - `sign` returns **65 bytes** (`r || s || v`), low-s normalised, because the
 *   contract's `ecrecover` needs `v` and rejects `s > n/2`. A 64-byte return
 *   would be unusable on chain and would fail late, at a revert.
 * - `handle.publicKey` is the **65-byte uncompressed SEC1** key
 *   (`0x04 || X || Y`), which is what `verifier_signing_keys.public_key` stores
 *   as 130 hex characters.
 *
 * And one refusal: `sign` takes a **32-byte digest**, never a message. Hashing
 * on the caller's behalf would produce a signature over something the caller
 * did not compute — and for EIP-712 the digest is the whole binding, so a
 * signer that re-hashed one would sign a value with no domain in it.
 */
@Injectable()
export class Secp256k1EnvSigner implements SignerPort {
  readonly backend = SignerBackend.ENV;

  private readonly logger = new Logger(Secp256k1EnvSigner.name);

  /** `keyId` → the scalar and everything derived from it. A `#private` field. */
  readonly #keys: ReadonlyMap<string, LoadedKey>;

  constructor(
    @Inject(EVM_SIGNING_KEY_SOURCES) sources: readonly EvmSigningKeySource[],
    @Optional() @Inject(ENV_SIGNER_WARNING) warning?: string,
  ) {
    this.#keys = load(sources);

    // The banner only when a key is actually resident. This provider is bound
    // in every process that imports the module, EVM keys or not, and an
    // operator told that a secp256k1 key is in the process when there is none
    // learns to skip the banner — which costs the ed25519 one its audience too.
    if (this.#keys.size > 0) {
      this.logger.warn('================================================================');
      for (const line of (warning ?? EVM_ENV_SIGNER_WARNING).split('\n')) {
        this.logger.warn(line);
      }
      this.logger.warn('================================================================');
      this.logger.log(
        `Loaded ${this.#keys.size} secp256k1 env signing key(s): ${[...this.#keys.keys()].join(', ')}`,
      );
    }
  }

  async listKeys(): Promise<readonly SignerKeyHandle[]> {
    return [...this.#keys.values()].map((key) => key.handle);
  }

  async getKey(keyId: string): Promise<SignerKeyHandle> {
    return this.resolve(keyId).handle;
  }

  async sign(keyId: string, message: Uint8Array): Promise<Uint8Array> {
    // Resolved BEFORE the digest is looked at, so a typo'd key id is reported
    // as a typo'd key id rather than as a bad digest.
    const key = this.resolve(keyId);
    if (message.length !== DIGEST_LENGTH) {
      throw VerificationErrors.signingKeyMaterialInvalid({
        reason:
          `secp256k1 signs a ${DIGEST_LENGTH}-byte digest; got ${message.length} bytes. ` +
          'Hash it where the domain is known — this backend will not hash for you',
      });
    }

    // @noble is low-s by default, and `derToRawSignature` folds it again
    // anyway. The DER round trip is not waste: it is the exact shape a KMS
    // returns, so both backends reach `v` by the same road and one suite covers
    // it. `recovery` from the signature object is deliberately NOT used — it
    // would be a second, unchecked route to the same answer.
    const signature = secp256k1.sign(message, key.scalar);
    return derToRawSignature(signature.toDERRawBytes(), message, key.handle.publicKey);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private resolve(keyId: string): LoadedKey {
    const key = this.#keys.get(keyId);
    if (!key) {
      throw VerificationErrors.signingKeyUnknown({ keyId, backend: this.backend });
    }
    return key;
  }
}

/**
 * What an operator sees when the EVM verifier key is held in-process.
 *
 * Its own sentence rather than the ed25519 banner, because the two keys are
 * rotated on separate schedules and an operator reading "the verifier signing
 * key" needs to know **which**.
 */
const EVM_ENV_SIGNER_WARNING = [
  'EVM_VERIFIER_SIGNING_KEYS is set — the secp256k1 verifier signing key is',
  'held in THIS process, and unlike the ed25519 one it is NOT held in a',
  'non-extractable key: WebCrypto has no secp256k1. See',
  'docs/architecture.md §"Signing Keys". Anyone who can read this process can',
  'sign attestations until it is closed.',
].join('\n');

interface LoadedKey {
  readonly handle: SignerKeyHandle;
  readonly scalar: Uint8Array;
}

function load(sources: readonly EvmSigningKeySource[]): ReadonlyMap<string, LoadedKey> {
  const keys = new Map<string, LoadedKey>();
  for (const source of sources) {
    keys.set(source.keyId, importKey(source));
  }
  return keys;
}

function importKey(source: EvmSigningKeySource): LoadedKey {
  if (!secp256k1.utils.isValidPrivateKey(source.secretKey)) {
    // Zero, and anything >= n. Both are values a truncated paste produces, and
    // both would otherwise throw from inside the curve library at the first
    // signature, during an incident.
    throw VerificationErrors.signingKeyMaterialInvalid({
      reason: `key "${source.keyId}" is not a valid secp256k1 scalar`,
    });
  }

  // A copy, because `source.secretKey` is zeroed below and this one has to
  // outlive it.
  const scalar = Uint8Array.from(source.secretKey);
  try {
    const publicKey = secp256k1.getPublicKey(scalar, false);
    const handle: SignerKeyHandle = {
      keyId: source.keyId,
      backend: SignerBackend.ENV,
      // The variable's NAME. A locator; the value it held is gone.
      backendRef: 'env:EVM_VERIFIER_SIGNING_KEYS',
      publicKey,
      curve: 'secp256k1',
      chainId: source.chainId,
    };
    assertKeyPairAgrees(source.keyId, scalar, publicKey);
    return { handle, scalar };
  } finally {
    source.secretKey.fill(0);
  }
}

/**
 * Sign something and recover from it, at boot, before the key is used for real.
 *
 * The failure this catches is silent and expensive: a key that produces
 * signatures nobody can recover the right address from still *works*, in the
 * sense that `sign` returns 65 bytes. It would be discovered when the contract
 * answers `VerifierNotRegistered` — during an incident, on the path that takes
 * money — rather than here, where it is a boot failure with a key id in it.
 */
function assertKeyPairAgrees(keyId: string, scalar: Uint8Array, publicKey: Uint8Array): void {
  // 32 deterministic bytes derived from the key id. Not an EIP-712 digest and
  // not a valid one: nothing this signs at boot can be replayed as an
  // attestation, because no typed-data encoding produces a preimage of this
  // shape.
  const probe = Uint8Array.from(
    Buffer.from(`x402-secp256k1-selftest:${keyId}`.padEnd(32, '.').slice(0, 32)),
  );
  let raw: Uint8Array;
  try {
    raw = derToRawSignature(secp256k1.sign(probe, scalar).toDERRawBytes(), probe, publicKey);
  } catch {
    throw VerificationErrors.signingKeyMaterialInvalid({
      reason: `key "${keyId}" failed its boot self-test — it signs, but not recoverably`,
    });
  }
  if (raw.length !== 65 || (raw[64] !== 27 && raw[64] !== 28)) {
    throw VerificationErrors.signingKeyMaterialInvalid({
      reason: `key "${keyId}" failed its boot self-test — the signature has no usable v`,
    });
  }
}
