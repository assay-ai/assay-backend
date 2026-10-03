/**
 * Squads v4 program id, deployed identically on every SVM cluster.
 * https://github.com/Squads-Protocol/v4
 */
export const SQUADS_V4_PROGRAM_ADDRESS = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';

/**
 * PDA seeds, copied verbatim from `sdk/multisig/src/pda.ts` in
 * `Squads-Protocol/v4` (confirmed against the program's own
 * `state/seeds.rs`, not guessed from the docs):
 *
 * ```
 * multisigPda = PDA(["multisig", "multisig", createKey], SQUADS_V4_PROGRAM_ADDRESS)
 * vaultPda    = PDA(["multisig", multisigPda, "vault", u8(vaultIndex)], SQUADS_V4_PROGRAM_ADDRESS)
 * ```
 *
 * `SEED_PREFIX` and `SEED_MULTISIG` are both the literal bytes `"multisig"` —
 * that duplication in the seed list is the program's, not a typo introduced
 * here.
 */
export const SQUADS_SEED_PREFIX = 'multisig';
export const SQUADS_SEED_MULTISIG = 'multisig';
export const SQUADS_SEED_VAULT = 'vault';

/** DI token for the base58 `create_key` the platform's multisig was created with. */
export const SOLANA_VAULT_MULTISIG_CREATE_KEY = 'SOLANA_VAULT_MULTISIG_CREATE_KEY';

/** DI token for which of the multisig's vaults holds agent funds. Almost always `0`. */
export const SOLANA_VAULT_INDEX = 'SOLANA_VAULT_INDEX';

/** The vault this platform actually operates. Multiple vaults per multisig exist on-chain; we use one. */
export const DEFAULT_VAULT_INDEX = 0;
