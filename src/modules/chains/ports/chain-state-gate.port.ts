/**
 * Refuse early what the chain would refuse anyway: a paused program, or a
 * party on the ON-CHAIN blocklist (assay-evm D-19, `X402Config.assertActive`).
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
}

export const CHAIN_STATE_GATE = 'CHAIN_STATE_GATE';
