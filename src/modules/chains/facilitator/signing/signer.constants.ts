/**
 * Configuration seams for both `FeePayerSignerPort` implementations —
 * injected rather than read from `ConfigService` inside the classes, matching
 * `facilitator.constants.ts`'s reasoning: a unit test constructs either signer
 * without a Nest container and without `process.env`.
 */

/** DI token — which implementation `FacilitatorModule` wires to `FEE_PAYER_SIGNER`. */
export const FEE_PAYER_SIGNER_MODE = 'FEE_PAYER_SIGNER_MODE';

/** DI token — base URL of the Kora RPC node. */
export const KORA_RPC_URL = 'KORA_RPC_URL';

/** DI token — per-request timeout in milliseconds for Kora JSON-RPC calls. */
export const KORA_TIMEOUT_MS = 'KORA_TIMEOUT_MS';

/** DI token — filesystem path to the local fallback signer's keypair JSON. */
export const LOCAL_FEE_PAYER_KEYPAIR_PATH = 'LOCAL_FEE_PAYER_KEYPAIR_PATH';

/**
 * Environment variable — the local signer's keypair supplied **inline**, as the
 * material itself rather than a path to it.
 *
 * Not a DI token: it is read once at boot by `takeLocalFeePayerKeypair`, which
 * deletes it. It exists because a deployment config can set a variable but cannot
 * create a file, so `LOCAL_FEE_PAYER_KEYPAIR_PATH` alone forces a volume mount
 * onto every deployment that wants the local signer — while every *other* key
 * this platform holds (`VERIFIER_SIGNING_KEYS`, `EXPOSURE_AUTHORITY_SIGNING_KEY`)
 * already arrives as a variable. The fee payer was the last exception.
 */
export const LOCAL_FEE_PAYER_KEYPAIR_ENV = 'LOCAL_FEE_PAYER_KEYPAIR';

export const DEFAULT_KORA_TIMEOUT_MS = 30_000;
