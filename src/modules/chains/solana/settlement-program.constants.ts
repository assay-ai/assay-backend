/**
 * What the backend needs to know about the Anchor settlement program that is
 * *not* in the program itself.
 *
 * ## The seeds used to live here, and no longer do
 *
 * This file used to carry `VERIFIER_SEED` and `SETTLEMENT_CONFIG_SEED`, copied
 * byte-for-byte out of the program's `constants.rs` because the PDA has to be
 * derived on both sides. They are now `findVerifierKeyPda` and `findConfigPda`
 * in `@x402/settlement-client`, generated from the IDL, so there is no second
 * copy to keep in step and no unit test needed to pin one against the other.
 *
 * What remains here is the one thing the program cannot tell us: **which
 * deployment of it this process is talking to.**
 */

/**
 * DI token for the deployed program id.
 *
 * `null` when unset: a deployment with no settlement program is a legitimate
 * state today — the program is on devnet and most processes never touch it — so
 * the failure belongs at the first call that needs an address, not at boot.
 *
 * Note that this is *not* redundant with the client's compiled-in
 * `SETTLEMENT_PROGRAM_ADDRESS`. That constant is `declare_id!()` — the address
 * the program was built for. This one is the address it was deployed to on the
 * cluster this process reads. They are the same on devnet and on mainnet by
 * intent, and they differ on any localnet whose validator was given a fresh
 * program keypair; code that assumes they cannot differ breaks on the first
 * local integration test.
 */
export const SETTLEMENT_PROGRAM_ID = 'SETTLEMENT_PROGRAM_ID';

/** The env var carrying it, named here so error messages can say it. */
export const SETTLEMENT_PROGRAM_ID_ENV = 'SOLANA_SETTLEMENT_PROGRAM_ID';
