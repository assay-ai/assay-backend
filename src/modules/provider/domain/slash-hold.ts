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
   * The provider's rolling slash window (or the verifier key's) is full, and
   * an upheld record is waiting to execute: the next penalty cannot be taken
   * until the window drains (`SlashCapExceeded`, `VerifierDailyCapExceeded`,
   * `SlashWindowNotDrained`).
   */
  SLASH_WINDOW_FULL = 'SLASH_WINDOW_FULL',
  /** `pendingSlash ≥ atRisk − penaltyAmount`: the free stake cannot back another penalty. */
  STAKE_FULLY_RESERVED = 'STAKE_FULLY_RESERVED',
  /** `bonded < minimumStake`. */
  BONDED_BELOW_MINIMUM = 'BONDED_BELOW_MINIMUM',
}

/** One provider's stake and the Config's parameters on one chain, read live. */
export interface SlashHoldStakeReading {
  readonly bonded: bigint;
  readonly unbonding: bigint;
  readonly pendingSlash: bigint;
  /** The provider window's counter and its start, as `stakeOf` returns them (undecayed). */
  readonly slashedInWindow: bigint;
  readonly slashWindowStartedAt: bigint;
  /** `params.penaltyAmount`: the most one record may take. */
  readonly penaltyAmount: bigint;
  /** `params.slashCapBps`: the provider window's allowance, of `atRisk`. */
  readonly slashCapBps: number;
  /** `params.minimumStake`. */
  readonly minimumStake: bigint;
}

/** What the platform's own rows say about records waiting to execute. */
export interface SlashHoldWaiting {
  /** An upheld case of this provider whose record is due on this chain. */
  readonly recordWaiting: boolean;
  /**
   * Its last execute attempt was refused by a full window — the provider's or
   * the verifier key's. The key's window is not readable over the ABI, so the
   * refusal is the evidence.
   */
  readonly windowRefused: boolean;
}

/** `SLASH_WINDOW_SECONDS` in `Constants.sol`: the rolling window's width. */
export const SLASH_WINDOW_SECONDS = 86_400n;

/** Checks with every condition false before a hold is released (the hysteresis). */
export const SLASH_HOLD_RELEASE_AFTER_CLEAR_CHECKS = 2;

/** `Window.decay` in assay-evm, rounded up the same way. */
export function decayedWindow(counter: bigint, startedAt: bigint, nowSeconds: bigint): bigint {
  if (counter === 0n) return 0n;
  if (nowSeconds <= startedAt) return counter;
  const elapsed = nowSeconds - startedAt;
  if (elapsed >= SLASH_WINDOW_SECONDS) return 0n;
  const remaining = SLASH_WINDOW_SECONDS - elapsed;
  return (counter * remaining + SLASH_WINDOW_SECONDS - 1n) / SLASH_WINDOW_SECONDS;
}

/** Every condition that holds now, in a fixed order; empty when none does. */
export function slashHoldReasons(
  stake: SlashHoldStakeReading,
  waiting: SlashHoldWaiting,
  nowSeconds: bigint,
): SlashHoldReason[] {
  const reasons: SlashHoldReason[] = [];
  const atRisk = stake.bonded + stake.unbonding;

  const capAllowance = (atRisk * BigInt(stake.slashCapBps)) / 10_000n;
  const carried = decayedWindow(stake.slashedInWindow, stake.slashWindowStartedAt, nowSeconds);
  const windowFull = carried >= capAllowance || waiting.windowRefused;
  if (windowFull && waiting.recordWaiting) reasons.push(SlashHoldReason.SLASH_WINDOW_FULL);

  if (stake.pendingSlash + stake.penaltyAmount >= atRisk) {
    reasons.push(SlashHoldReason.STAKE_FULLY_RESERVED);
  }

  if (stake.bonded < stake.minimumStake) reasons.push(SlashHoldReason.BONDED_BELOW_MINIMUM);
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
