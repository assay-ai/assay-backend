/**
 * The provider "slash hold": stop routing paid calls to a provider, on one
 * chain, whose penalties can no longer be collected promptly, so penalties do
 * not keep piling up behind a stake that cannot pay them (owner feature).
 *
 * Pure. The inputs are the provider's stake on that chain and the Config's
 * parameters, read live and cached by `EvmSlashHoldMonitor`, plus whether the
 * platform has an upheld record of this provider waiting to execute there.
 */

/** Why a provider is held, as the provider's banner and the operator see it. */
export enum SlashHoldReason {
  /**
   * An upheld record is waiting to execute and its last attempt was refused
   * `SlashWindowNotDrained`: the provider's rolling
   * window cannot take it whole, and execution is all or wait (assay-evm
   * 9f036a3), so nothing is collected until the window drains.
   */
  SLASH_WINDOW_FULL = 'SLASH_WINDOW_FULL',
  /**
   * `atRisk − pendingSlash < penaltyAmount`: the free stake cannot back
   * another penalty. Reservations of records frozen by an on-chain dispute are
   * left out of `pendingSlash` (see {@link SlashHoldStakeReading.disputedReserved}).
   */
  STAKE_FULLY_RESERVED = 'STAKE_FULLY_RESERVED',
  /**
   * FREE bonded stake below the minimum: `bonded − pendingSlash < minimumStake`
   * (assay-evm D-26), the redeem gate's own rule — every standing record's
   * reservation counts here, disputed ones included, because the chain counts
   * them. The value keeps its stored name.
   */
  BONDED_BELOW_MINIMUM = 'BONDED_BELOW_MINIMUM',
}

/** One provider's stake and the Config's parameters on one chain, read live. */
export interface SlashHoldStakeReading {
  readonly bonded: bigint;
  readonly unbonding: bigint;
  readonly pendingSlash: bigint;
  /** `params.penaltyAmount`: the most one record may take. */
  readonly penaltyAmount: bigint;
  /** `params.minimumStake`. */
  readonly minimumStake: bigint;
  /**
   * The part of `pendingSlash` reserved by this platform's records that stand
   * `DISPUTED` on chain. Left out of the reservation check
   * (`STAKE_FULLY_RESERVED`, review S-6), even though the record keeps its
   * reservation until the arbiter rules or the 30-day timeout ends it. NOT
   * left out of the free-bonded minimum (`BONDED_BELOW_MINIMUM`): since D-26
   * the chain's redeem gate counts every reservation, so a provider whose
   * disputed records push its free bonded stake below the minimum is not paid,
   * and must not be routed paid calls.
   */
  readonly disputedReserved?: bigint;
}

/** What the platform's own rows say about records waiting to execute. */
export interface SlashHoldWaiting {
  /** An upheld case of this provider whose record is due on this chain. */
  readonly recordWaiting: boolean;
  /** Its last execute attempt (the case's or a part's) was refused `SlashWindowNotDrained`. */
  readonly windowRefused: boolean;
}

/** Checks with every condition false before a hold is released (the hysteresis). */
export const SLASH_HOLD_RELEASE_AFTER_CLEAR_CHECKS = 2;

/** Every condition that holds now, in a fixed order; empty when none does. */
export function slashHoldReasons(
  stake: SlashHoldStakeReading,
  waiting: SlashHoldWaiting,
): SlashHoldReason[] {
  const reasons: SlashHoldReason[] = [];
  const atRisk = stake.bonded + stake.unbonding;

  if (waiting.recordWaiting && waiting.windowRefused) {
    reasons.push(SlashHoldReason.SLASH_WINDOW_FULL);
  }

  // Held only when one more full penalty no longer fits: free stake exactly
  // equal to one penalty can still back it (review S-6).
  const disputed = stake.disputedReserved ?? 0n;
  const reserved = stake.pendingSlash > disputed ? stake.pendingSlash - disputed : 0n;
  if (reserved + stake.penaltyAmount > atRisk) {
    reasons.push(SlashHoldReason.STAKE_FULLY_RESERVED);
  }

  // D-26: the redeem gate reads `bonded − pendingSlash` (all of it, disputed
  // records included), so the hold does too.
  const freeBonded = stake.bonded > stake.pendingSlash ? stake.bonded - stake.pendingSlash : 0n;
  if (freeBonded < stake.minimumStake) reasons.push(SlashHoldReason.BONDED_BELOW_MINIMUM);
  return reasons;
}

/** The stored state of one provider's hold on one chain. */
export interface SlashHoldState {
  readonly held: boolean;
  readonly reasons: readonly SlashHoldReason[];
  /** Consecutive checks with no condition true while still held. */
  readonly clearChecks: number;
  readonly heldSince: Date | null;
}

export const NOT_HELD: SlashHoldState = Object.freeze({
  held: false,
  reasons: [],
  clearChecks: 0,
  heldSince: null,
});

/**
 * The next state after one check. Holds at once on any condition; releases
 * only after {@link SLASH_HOLD_RELEASE_AFTER_CLEAR_CHECKS} consecutive clear
 * checks, so a window draining and refilling does not flap routing.
 */
export function nextSlashHoldState(
  previous: SlashHoldState,
  reasons: readonly SlashHoldReason[],
  now: Date,
): SlashHoldState {
  if (reasons.length > 0) {
    return { held: true, reasons, clearChecks: 0, heldSince: previous.heldSince ?? now };
  }
  if (!previous.held) return NOT_HELD;
  const clearChecks = previous.clearChecks + 1;
  if (clearChecks >= SLASH_HOLD_RELEASE_AFTER_CLEAR_CHECKS) return NOT_HELD;
  return { ...previous, clearChecks };
}
