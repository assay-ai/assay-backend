import { AccountId, AssetId } from './caip.types';
import { Money } from './money.types';

/**
 * The account that holds buyers' money on a chain, for proof of reserves: on
 * EVM the `AssayEscrow` contract, whose token balance must cover every buyer
 * escrow and held payment the ledger records. Solana has none (its pooled
 * Squads treasury is gone); `NamespaceVaultPort` answers a Solana asset with
 * `CHAIN_UNSUPPORTED`.
 *
 * Deliberately separate from `ChainAdapter.getVaultAccount(owner, asset)`:
 * that method derives the receiving token account for *any* owner an intent
 * names. `VaultPort` is about exactly one account per chain — this platform's
 * own — and it is the only thing in the domain allowed to assert control over
 * it.
 */
export interface VaultPort {
  /** The account that owns the vault's holding of `asset` (on EVM, the escrow contract). */
  getVaultOwner(asset: AssetId): Promise<AccountId>;

  /** The account that actually holds `asset`. */
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
   * Proves, on chain, that the vault is what it claims to be (on EVM, the
   * deployed escrow contract and its configured roles). Throws
   * `CHAIN_VAULT_CONTROL_UNVERIFIED` on any mismatch — a vault whose control
   * cannot be proven must fail loudly at the point of use, never be assumed.
   */
  assertVaultControl(asset: AssetId): Promise<void>;
}

/** DI token for the vault this platform actually operates. */
export const VAULT_PORT = 'VAULT_PORT';
