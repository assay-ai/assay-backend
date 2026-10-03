/**
 * Environment variable names and DI tokens for the verifier signing path.
 *
 * The names live in one file because two different kinds of reader need them:
 * an operator provisioning a deployment, and the redaction guard in
 * `key-material-redaction.ts`, which has to know exactly which variables carry
 * secrets in order to promise that they are gone.
 */

/**
 * The private key material, for `VERIFIER_SIGNER_BACKEND=env` only.
 *
 * **Read once at boot and then deleted from `process.env`** — see
 * `backends/env-keypair.signer.ts`. Nothing else in the codebase may read it,
 * and after boot there is nothing to read.
 */
export const VERIFIER_SIGNING_KEYS_ENV = 'VERIFIER_SIGNING_KEYS';

/**
 * The secp256k1 private key material, for the EVM verifier key.
 *
 * A JSON array of `{ keyId, chainId, secretKey }` — a **different variable**
 * from {@link VERIFIER_SIGNING_KEYS_ENV}, and deliberately so: the EVM
 * verifier key is secp256k1 and must never be the Solana ed25519 one; key ids
 * are `verifier-solana-<yyyy-mm>` and `verifier-evm-<yyyy-mm>`, rotated
 * independently on their own 180-day schedules. One variable holding both
 * curves would make "which key signs for which chain" a parsing question
 * instead of a provisioning one.
 *
 * Read once at boot and then deleted from `process.env`, through the same
 * {@link takeOnceFromEnv} the ed25519 variable goes through.
 */
export const EVM_VERIFIER_SIGNING_KEYS_ENV = 'EVM_VERIFIER_SIGNING_KEYS';

/** DI token for the parsed secp256k1 env-backend key material. */
export const EVM_SIGNING_KEY_SOURCES = 'EVM_SIGNING_KEY_SOURCES';

/**
 * DI token: `ReadonlyMap<SigningCurve, SignerPort>` — which custody backend
 * holds the material for each signature scheme.
 *
 * `SIGNER_PORT` resolves to exactly one backend, which was sufficient while
 * every key was ed25519. It is not now: the EVM verifier key is secp256k1, it
 * lives in a different variable, and it is held by a different class. Without
 * this map `Secp256k1EnvSigner` has no route to the signing path at all — the
 * ed25519 backend would be asked for the EVM key id and answer
 * `signingKeyUnknown`, which is loud but is a feature that does not work.
 *
 * Keyed on the CURVE rather than on the chain: which scheme a chain verifies is
 * a property of the chain (`curveForChain`), while which service holds the
 * material is a property of the deployment, and collapsing them would mean a
 * map entry per chain all pointing at the same backend.
 */
export const SIGNERS_BY_CURVE = 'SIGNERS_BY_CURVE';

/** Which `SignerPort` implementation to resolve. A `SignerBackend` value. */
export const VERIFIER_SIGNER_BACKEND_ENV = 'VERIFIER_SIGNER_BACKEND';

/** DI token for the resolved signing configuration. */
export const VERIFIER_SIGNING_CONFIG = 'VERIFIER_SIGNING_CONFIG';

/** DI token for the parsed env-backend key material, injected once at boot. */
export const ENV_SIGNING_KEY_SOURCES = 'ENV_SIGNING_KEY_SOURCES';

/**
 * DI token for the sentence `EnvKeypairSigner` warns with at boot.
 *
 * Optional, and defaulting to the verifier key's warning. It exists because
 * a **second** env-held key (such as a stake-exposure authority) can reuse this
 * exact backend — one implementation of "key material through the environment,
 * deleted at boot, imported non-extractably", not two — and a banner that told
 * an operator the *verifier* key was in the process when it was the exposure
 * authority would be a false statement in the one place they are reading for
 * true ones.
 */
export const ENV_SIGNER_WARNING = 'ENV_SIGNER_WARNING';

/**
 * The KMS key ARNs, for `VERIFIER_SIGNER_BACKEND=kms`.
 *
 * A JSON array of `{ keyId, arn }`. **Not a secret** — an ARN names a key
 * without granting anything, and IAM decides who may call `Sign` on it. That
 * asymmetry is the whole point of moving off `VERIFIER_SIGNING_KEYS`: the
 * variable that replaces it is safe to print.
 */
export const VERIFIER_KMS_KEYS_ENV = 'VERIFIER_KMS_KEYS';

/** DI token for the parsed {@link KmsKeyRef} list. */
export const KMS_SIGNING_KEY_REFS = 'KMS_SIGNING_KEY_REFS';

/**
 * DI token for the KMS client itself.
 *
 * Unbound today: no `@aws-sdk/client-kms` dependency exists, and adding a cloud
 * SDK for a path nothing calls yet is weight that never comes back off. Wiring
 * production means installing it and providing a `KmsSigningClient` adapter
 * here — see `backends/aws-kms.signer.ts`.
 */
export const KMS_SIGNING_CLIENT = 'KMS_SIGNING_CLIENT';

/** DI token for the rate limiter's own Redis connection. */
export const SIGNING_RATE_REDIS = 'SIGNING_RATE_REDIS';

/** DI token for the resolved {@link SigningRateLimits}. */
export const SIGNING_RATE_LIMITS = 'SIGNING_RATE_LIMITS';

/**
 * How long a registry lookup is trusted before it is read again.
 *
 * This is the delay between an operator revoking a key on-chain and this
 * platform noticing. It is short — the whole point of the on-chain revoke is
 * that it takes effect immediately, and a cache is the one thing that could
 * make it not.
 */
export const DEFAULT_REGISTRY_CACHE_MS = 15_000;

/**
 * How long before a key's on-chain expiry the platform starts complaining.
 *
 * Two weeks: long enough that a rotation can be scheduled rather than
 * scrambled, short enough that the warning is still connected to the deadline
 * when it arrives.
 */
export const DEFAULT_EXPIRY_WARNING_MS = 14 * 24 * 60 * 60 * 1000;
