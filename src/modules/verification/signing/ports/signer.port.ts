import { ChainId } from '@modules/chains/ports/caip.types';

import { SigningCurve } from '../domain/key-curve';

/**
 * Custody of the verifier signing key, behind a port.
 *
 * ## What this port is for
 *
 * Among the assets worth attacking, the verifier signing key ranks second: *forged
 * attestations → provider stake drained*. Whoever holds it can take money from
 * every provider on the platform. So the question this port answers is not
 * "how do we sign" — it is **"what is the smallest thing the application is
 * allowed to know about the key"** — and the answer, expressed as an interface,
 * is: an opaque id, a public key, and the ability to ask for a signature.
 *
 * ## The invariant
 *
 * **No method here returns private key material, and none ever may.**
 *
 * That is the one rule that makes every backend below interchangeable. A KMS
 * *cannot* hand back the private key; the env backend below *can*, in the sense
 * that the bytes pass through the process at boot — so it takes deliberate care
 * not to (`env-keypair.signer.ts` §"What the env backend does to earn the
 * name"). If this interface ever grew an `exportKey`, the env backend would
 * implement it, some caller would use it, and swapping in KMS later would stop
 * being a configuration change and become a rewrite. The interface is the thing
 * holding that door shut, so it is worth stating twice.
 *
 * `test/unit/verification/signing/signer-port-contract.spec.ts` asserts it
 * against the shape of the interface rather than trusting this comment.
 *
 * ## Why a port at all, when the MVP is an environment variable
 *
 * The security model says the key belongs in a KMS and the MVP ships it in an
 * environment variable — a deliberate, recorded divergence (see
 * `docs/architecture.md` §"Signing keys"). The divergence is only
 * affordable because the *shape* of the eventual answer is fixed now: every
 * candidate custody service — AWS KMS, GCP KMS, Turnkey, HashiCorp Vault, Privy
 * — exposes exactly this, an opaque handle plus a remote `sign`. Writing the
 * call sites against that shape today means the swap is a new class and one
 * line of wiring, and — the part that actually matters — it means no call site
 * can have quietly grown a dependency on holding the key, because there was
 * never an interface through which to hold it.
 *
 * The corollary is worth stating: every method is `async`, including
 * {@link SignerPort.getKey}. A remote signer's operations are network calls, and
 * a synchronous signature is the one design decision that would make the swap a
 * rewrite of every caller rather than a change of provider.
 */

/**
 * Which custody service is holding the key.
 *
 * Recorded on every key and on every line of the signing journal, because
 * "where was this key when it signed" is the first question of a key-compromise
 * investigation and the answer must not have to be reconstructed from what the
 * config said at the time.
 */
export enum SignerBackend {
  /**
   * The private key is provisioned through an environment variable and lives in
   * this process's memory. The MVP path, and the only one implemented today.
   */
  ENV = 'env',
  /** AWS KMS / GCP KMS — the target the security model names. */
  KMS = 'kms',
  TURNKEY = 'turnkey',
  /** HashiCorp Vault transit engine. */
  VAULT = 'vault',
  PRIVY = 'privy',
}

/**
 * Everything the application is allowed to know about a key.
 *
 * Note what is absent, and note that it is absent by construction rather than
 * by convention: there is no field a private key could be assigned to.
 */
export interface SignerKeyHandle {
  /**
   * Our stable identifier for this key — `verifier-2026-08`.
   *
   * Chosen by us, not by the backend, and deliberately: it is what the signing
   * journal records, what the on-chain registry entry is labelled with, and
   * what an operator says out loud during an incident. A KMS ARN changes shape
   * when the KMS changes; this does not.
   */
  readonly keyId: string;
  readonly backend: SignerBackend;
  /**
   * How the backend finds the key — the env var name, the KMS key ARN, the
   * Turnkey private-key id, the Vault path.
   *
   * A *locator*, never a secret, and it appears in logs. For the env backend
   * that means the variable's **name**; the value is what must not be here.
   */
  readonly backendRef: string;
  /**
   * The raw public key. Public, and safe to log.
   *
   * **Its length depends on {@link curve}**: 32 bytes for ed25519, 65 for
   * secp256k1's uncompressed SEC1 form (`0x04 || X || Y`) — which is what
   * `verifier_signing_keys.public_key` stores as 130 hex characters, and the
   * reason that column was widened to `varchar(256)`. Nothing may assume 32.
   */
  readonly publicKey: Uint8Array;

  /**
   * Which signature scheme this key's material is for.
   *
   * Added for multichain support, and **intrinsic rather than configured**: a backend knows what
   * it loaded, so this cannot be set wrong in an environment variable. It is
   * what `VerifierKeyDirectory` checks against {@link curveForChain} before
   * handing the key a chain's payload — the gate that stops an ed25519
   * signature being submitted to `ecrecover`, where it is not malformed but
   * simply somebody else's.
   */
  readonly curve: SigningCurve;

  /**
   * The chain this key is provisioned for, when the backend's configuration
   * says so — and `null` when it does not.
   *
   * It is nullable, and the reason is a compatibility one that matters:
   * `VERIFIER_SIGNING_KEYS`, the ed25519 env format, has shipped as `{ keyId, secretKey }` and carries no
   * chain. Making the field required would mean either breaking every existing
   * deployment's variable or **inventing** a chain id for keys that never
   * declared one — and inventing one is the failure this whole per-chain change
   * exists to prevent, since `solana:5eykt4Us…` and `solana:EtWTRABZ…` differ
   * by a mainnet.
   *
   * So: a backend that pins declares it (the EVM env format requires it), and
   * the directory cross-checks it against the chain it was asked for. A backend
   * that does not pin says `null`, and the directory falls back to the curve
   * gate — which is the property that actually protects money, because it is
   * the one the chain itself enforces.
   */
  readonly chainId: ChainId | null;
}

/**
 * The custody seam.
 *
 * Implementations are responsible for custody and for the signing primitive,
 * and for nothing else. In particular they know nothing about *which* key is
 * current, whether it is registered on-chain, how often it may be used, or what
 * it is signing — those are the key directory's, the registry's, the rate
 * limiter's and the caller's problems respectively. A backend that also decided
 * policy would have to be re-implemented, correctly, once per vendor.
 */
export interface SignerPort {
  readonly backend: SignerBackend;

  /**
   * Every key this backend can sign with, current and retired alike.
   *
   * Retired keys stay listed on purpose. Rotation is only non-disruptive if the
   * outgoing key remains usable for as long as it takes to cut over, and an
   * incident review needs to resolve the key id on a months-old journal line to
   * a public key — which is impossible if the backend forgets keys it no longer
   * uses. Which of them is *allowed* to sign is a separate question, and a
   * separate object: `VerifierKeyDirectory`.
   */
  listKeys(): Promise<readonly SignerKeyHandle[]>;

  /** Throws `VerificationErrors.signingKeyUnknown` if this backend has no such key. */
  getKey(keyId: string): Promise<SignerKeyHandle>;

  /**
   * Produce a detached signature over `message`, in this backend's curve.
   *
   * Raw bytes rather than a domain object, and that is the boundary: this port
   * signs what it is handed and has no opinion about what the bytes mean. The
   * canonical encoding of an attestation — the part that decides what the
   * signature actually covers, and therefore what an attacker can change
   * afterwards — belongs to the attestation encoder, and it belongs next to the on-chain code that
   * verifies it, not inside a custody adapter that will be swapped out.
   */
  sign(keyId: string, message: Uint8Array): Promise<Uint8Array>;
}

/** DI token for the custody backend this deployment resolves to. */
export const SIGNER_PORT = 'SIGNER_PORT';
