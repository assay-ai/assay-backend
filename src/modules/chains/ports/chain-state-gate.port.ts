/**
 * Refuse early what the chain would refuse anyway: a paused program, or a
 * party on the ON-CHAIN blocklist (assay-evm D-19, `AssayConfig.assertActive`).
 *
 * ## A stale cache must never lose money
 *
 * The answer comes from a cache (`EvmChainStateService`, fed by the indexer),
 * and a cache can be wrong in both directions. So:
 *
 * - "active" is never a promise — the contract is the final enforcer and
 *   still reverts what it reverts;
 * - "inactive" is CONFIRMED with a live read before {@link assertActive}
 *   refuses or {@link holdReason} holds, so a stale "paused" or "blocked"
 *   cannot block a buyer's exit or let a voucher expire unredeemed. If the
 *   live read fails, {@link assertActive} refuses (a refusal moves nothing)
 *   and {@link holdReason} does NOT hold (a hold can cost a voucher).
 *
 * Non-eip155 accounts pass: the Solana program has its own checks and no
 * on-chain blocklist.
 */

/** The doors the pause or the blocklist closes, by what the backend builds. */
export enum ChainDoor {
  /** `depositFor` — paused and blocklisted on every Config. */
  DEPOSIT = 'DEPOSIT',
  /** `redeemVoucher(Batch)`; also voucher acceptance and seq issuance. */
  REDEEM = 'REDEEM',
  /** `requestWithdraw(BySig)`, `withdraw` — gated since the upgrade only. */
  WITHDRAW = 'WITHDRAW',
  /** `setLimits(BySig)` — since the upgrade only. */
  LIMITS = 'LIMITS',
  /** `authorizeDelegate(BySig)` — since the upgrade only. Revoking is never gated. */
  DELEGATE = 'DELEGATE',
  /** `depositStake(For)`, `requestUnstake`, `withdrawStake` — since the upgrade only. */
  STAKE = 'STAKE',
}

/** One party to an action: a role for the error, and a CAIP-10 account. */
export interface ChainParty {
  readonly role: string;
  readonly account: string | null | undefined;
}

export interface ChainStateGatePort {
  /** Throws `CHAIN_PROGRAM_PAUSED` or `CHAIN_ADDRESS_BLOCKED` when the chain would refuse. */
  assertActive(door: ChainDoor, parties: readonly ChainParty[]): Promise<void>;
  /** Why the chain would refuse right now (confirmed live), or `null`. Never throws. */
  holdReason(door: ChainDoor, parties: readonly ChainParty[]): Promise<string | null>;
  /**
   * Every account the cache says is blocked on `chainId`, CONFIRMED live, as
   * lower-case CAIP-10. A failed live read leaves that address out (the hold
   * rule: a hold can cost a voucher). `[]` for a chain with no blocklist.
   * Never throws. The redemption queue leaves these parties out of its query,
   * so a blocked party cannot fill a pass and starve every other buyer (E-1).
   */
  blockedAccounts?(chainId: string): Promise<readonly string[]>;
  /**
   * Whether `account` (CAIP-10) is on its chain's on-chain blocklist, read
   * LIVE from the contract — no cache in front. `null` when it cannot be told
   * (the read failed, or the chain has no blocklist). Never throws.
   *
   * Used where the chain refused with `AddressBlocked` without saying whose
   * address, and where this pass's blocklist snapshot could not be read: the
   * cause decides whether the provider forfeits or the payer's voucher is held
   * (review 2026-10-15, M1).
   */
  isBlockedLive?(account: string): Promise<boolean | null>;
}

export const CHAIN_STATE_GATE = 'CHAIN_STATE_GATE';
