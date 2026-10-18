/**
 * What the backend needs to know about the Anchor settlement program that is
 * *not* in the program itself: **which deployment of it this process is
 * talking to.** The PDA seeds come from `@x402/settlement-client`
 * (`findVerifierKeyPda`, `findConfigPda`), generated from the IDL.
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
