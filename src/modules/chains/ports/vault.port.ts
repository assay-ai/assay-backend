import { AccountId, AssetId } from './caip.types';
import { Money } from './money.types';

/**
 * The platform treasury vault — the one Squads-controlled account that
 * custodies every agent's **legacy** deposited balance on a chain, until the
 * cutover moves it onto per-buyer escrows. Deposits no longer land here —
 * `DepositService` points every new one at the buyer's own escrow — so what is
 * left is proof of reserves over what has not yet been migrated, and
 * `sweep_fees`, which is a settlement-program door and not a Squads one at
 * all.
 *
 * Deliberately separate from `ChainAdapter.getVaultAccount(owner, asset)`:
 * that method derives the receiving token account for *any* owner an intent
 * names, generic enough to also be used for provider stake or a future
 * per-agent channel PDA. `VaultPort` is about exactly one account — this
 * platform's own treasury — and it is the only thing in the domain allowed to
 * assert control over it or propose moving money out of it.
 *
 * Each chain has its own implementation behind this port (on EVM a contract,
 * not a Squads multisig) rather than a second method on this one.
 */
export interface VaultPort {
  /** The multisig vault PDA that owns the treasury's token account for `asset`. */
  getVaultOwner(asset: AssetId): Promise<AccountId>;

  /** The token account (an ATA on SVM) that actually holds `asset`. */
  getVaultAccount(asset: AssetId): Promise<AccountId>;

  /** The vault's on-chain balance of `asset` — the left side of proof of reserves. */
  getVaultBalance(asset: AssetId): Promise<Money>;

  /**
   * The same balance, **and the slot it was true at**.
   *
   * Beside `getVaultBalance` rather than replacing it: a dozen callers only
   * want the money and should not grow a field they discard. This exists
   * because the proof-of-reserves page publishes the reading on a page with no login, and a
   * published balance with no slot cannot be checked by the reader — by the
   * time they look, the vault has moved. The slot is what turns "trust us"
   * into "go and look".
   *
   * Implementations must derive both from **one** RPC call, so the two can
   * never describe different moments.
   */
  getVaultBalanceAt(asset: AssetId): Promise<{ balance: Money; slot: bigint }>;

  /**
   * Proves, on chain, that the vault is what it claims to be: the vault ATA's
   * authority is the derived vault PDA, and the account at the derived
   * multisig PDA is owned by the Squads program. Throws
   * `CHAIN_VAULT_CONTROL_UNVERIFIED` on any mismatch — a vault whose control
   * cannot be proven must fail loudly at the point of use, never be assumed.
   */
  assertVaultControl(asset: AssetId): Promise<void>;
}

/** DI token for the vault this platform actually operates. */
export const VAULT_PORT = 'VAULT_PORT';
