import { Inject, Injectable, Logger } from '@nestjs/common';

import { VerificationErrors } from '../../errors/verification.errors';
import { KMS_SIGNING_CLIENT, KMS_SIGNING_KEY_REFS } from '../signing.constants';
import { SignerBackend, SignerKeyHandle, SignerPort } from '../ports/signer.port';

/**
 * `SignerPort` backed by AWS KMS — the custody target the security model names.
 *
 * ## Why this exists before anything uses it
 *
 * `docs/architecture.md` §"Signing Keys" promises that moving off the environment
 * variable is a new class and one line of wiring. A seam with a single
 * implementation cannot support that promise: it is untested by construction,
 * and the first real backend is exactly where you discover which of the port's
 * guarantees were accidents of the env implementation. Writing the second one
 * now is what converts the promise into a fact, and it is cheap — the whole
 * class is sixty lines because the port was designed for it.
 *
 * It also settles a question that had been carried implicitly. Solana
 * verifies **Ed25519**, and for most of KMS's life KMS could not produce an
 * Ed25519 signature at all — which would have made "the verifier key lives in
 * AWS KMS" unimplementable as written, on the one key the security model cares
 * most about. AWS added EdDSA in November 2025 (`ECC_NIST_EDWARDS25519`, signing
 * algorithm `ED25519_SHA_512`), so the KMS target is viable. Checked, not
 * assumed.
 *
 * ## `MessageType: RAW`, and why it is not a detail
 *
 * KMS offers `ED25519_SHA_512` over a `RAW` message and `ED25519_PH_SHA_512`
 * over a pre-hashed `DIGEST`. Only the first is plain Ed25519 — the second is
 * Ed25519ph, a *different* signature scheme with a different domain separator,
 * and the Solana `ed25519` sig-verify instruction rejects it. Getting this wrong
 * produces 64 well-formed bytes that no verifier on earth accepts, and the
 * failure surfaces on-chain rather than here.
 *
 * ## The client is declared structurally
 *
 * There is no `@aws-sdk/client-kms` dependency, and this file does not add one.
 * The two calls it makes are declared as an interface — the same pattern
 * `SolanaChainAdapter`, `LocalKeypairFeePayerSigner` and `decode-svm-payload.ts`
 * all use — so the class is fully testable now, and wiring it to production
 * means installing the SDK and providing a real client to `KMS_SIGNING_CLIENT`.
 * Adding a cloud SDK to the dependency tree for a path nothing calls yet is the
 * kind of weight that never comes back off.
 */
@Injectable()
export class AwsKmsSigner implements SignerPort {
  readonly backend = SignerBackend.KMS;

  private readonly logger = new Logger(AwsKmsSigner.name);
  /** `keyId` → its public key, fetched once. KMS charges per call and this never changes. */
  private readonly publicKeys = new Map<string, Uint8Array>();

  constructor(
    @Inject(KMS_SIGNING_CLIENT) private readonly kms: KmsSigningClient,
    @Inject(KMS_SIGNING_KEY_REFS) private readonly keyRefs: readonly KmsKeyRef[],
  ) {
    this.logger.log(
      `Verifier signing keys are in AWS KMS: ${keyRefs.map((k) => k.keyId).join(', ') || '(none)'}`,
    );
  }

  async listKeys(): Promise<readonly SignerKeyHandle[]> {
    return Promise.all(this.keyRefs.map((ref) => this.getKey(ref.keyId)));
  }

  async getKey(keyId: string): Promise<SignerKeyHandle> {
    const ref = this.refFor(keyId);
    return {
      keyId,
      backend: SignerBackend.KMS,
      // The ARN. A locator, and not a secret — it names the key without
      // granting anything; IAM decides who may call `Sign` on it.
      backendRef: ref.arn,
      publicKey: await this.publicKeyFor(ref),
      // `ED25519_SHA_512` below is the only algorithm this class asks KMS for,
      // so the curve is a property of the class rather than of the key ref.
      // A secp256k1 KMS backend is a DIFFERENT class, not a branch here.
      curve: 'ed25519',
      // `VERIFIER_KMS_KEYS` is `{ keyId, arn }` and declares no chain. See
      // `SignerKeyHandle.chainId` for why that is `null` rather than a guess.
      chainId: null,
    };
  }

  async sign(keyId: string, message: Uint8Array): Promise<Uint8Array> {
    const ref = this.refFor(keyId);
    const { Signature } = await this.kms.sign({
      KeyId: ref.arn,
      Message: message,
      MessageType: 'RAW',
      SigningAlgorithm: 'ED25519_SHA_512',
    });

    if (!Signature || Signature.length !== ED25519_SIGNATURE_LENGTH) {
      // A short or absent signature from a remote service is a wire problem or
      // the wrong algorithm on the key. Caught here rather than handed on: 64
      // bytes is the only shape the program will accept, and a malformed one
      // would be journalled as a real signature.
      throw VerificationErrors.signingKeyMaterialInvalid({
        reason:
          `KMS returned ${Signature?.length ?? 0} bytes for "${keyId}"; ` +
          `an Ed25519 signature is ${ED25519_SIGNATURE_LENGTH}`,
      });
    }
    return new Uint8Array(Signature);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private refFor(keyId: string): KmsKeyRef {
    const ref = this.keyRefs.find((candidate) => candidate.keyId === keyId);
    if (!ref) {
      throw VerificationErrors.signingKeyUnknown({ keyId, backend: this.backend });
    }
    return ref;
  }

  private async publicKeyFor(ref: KmsKeyRef): Promise<Uint8Array> {
    const cached = this.publicKeys.get(ref.keyId);
    if (cached) {
      return cached;
    }

    const { PublicKey, KeySpec } = await this.kms.getPublicKey({ KeyId: ref.arn });
    if (KeySpec !== ED25519_KEY_SPEC) {
      // An RSA or P-256 key would return a longer SPKI whose trailing 32 bytes
      // are meaningless, and the resulting "public key" would be enrolled
      // on-chain and never verify anything.
      throw VerificationErrors.signingKeyMaterialInvalid({
        reason: `KMS key "${ref.keyId}" is ${KeySpec ?? 'of unknown spec'}, not ${ED25519_KEY_SPEC}`,
      });
    }
    if (!PublicKey || PublicKey.length !== SPKI_ED25519_LENGTH) {
      throw VerificationErrors.signingKeyMaterialInvalid({
        reason: `KMS returned a ${PublicKey?.length ?? 0}-byte SPKI for "${ref.keyId}"`,
      });
    }

    // DER SPKI: a 12-byte header fixed by the algorithm, then the raw key.
    const raw = new Uint8Array(PublicKey.subarray(SPKI_ED25519_HEADER_LENGTH));
    this.publicKeys.set(ref.keyId, raw);
    return raw;
  }
}

/** Our key id paired with the KMS key that holds it. Neither value is a secret. */
export interface KmsKeyRef {
  readonly keyId: string;
  /** The KMS key ARN or id. */
  readonly arn: string;
}

/**
 * The two KMS calls this backend makes.
 *
 * Structural rather than `KMSClient` from the SDK — see the class comment. The
 * field names are AWS's so that the adapter over the real client is a one-line
 * `send(new SignCommand(input))` with nothing renamed in between.
 */
export interface KmsSigningClient {
  sign(input: {
    KeyId: string;
    Message: Uint8Array;
    MessageType: 'RAW';
    SigningAlgorithm: 'ED25519_SHA_512';
  }): Promise<{ Signature?: Uint8Array }>;

  getPublicKey(input: { KeyId: string }): Promise<{ PublicKey?: Uint8Array; KeySpec?: string }>;
}

const ED25519_KEY_SPEC = 'ECC_NIST_EDWARDS25519';
const ED25519_SIGNATURE_LENGTH = 64;
/** 12-byte DER header + the 32-byte key. */
const SPKI_ED25519_LENGTH = 44;
const SPKI_ED25519_HEADER_LENGTH = 12;
