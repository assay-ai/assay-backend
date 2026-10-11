/**
 * What a change to the payer's caps must still leave room for (BUG-D1-07).
 *
 * A rail-B voucher is served minutes before the chain redeems it, and the
 * chain applies the caps standing AT REDEMPTION: the per-voucher cap, the
 * rolling window (its decayed counter plus this voucher), and, for a
 * delegate-signed one, the delegate's authority and `validUntil`. Lower a cap
 * below what the served-but-unredeemed vouchers need, and the chain refuses
 * them; the provider was served and the platform absorbs the loss.
 *
 * Pure: no I/O, no clock. The figures come from the chain read and the
 * platform's own `payment_intents`; the decision is here so the intent routes,
 * the submit routes and their tests apply one rule.
 */

/** The vouchers the chain has not redeemed yet, beside the counter they will land on. */
export interface UnsettledVouchers {
  readonly count: number;
  /** Atomic units, `Σ` of the vouchers. */
  readonly total: bigint;
  /** The largest single voucher. */
  readonly largest: bigint;
  /**
   * What the window must hold for all of them to redeem: the chain's decayed
   * counter, plus anything redeemed after it was read, plus `total`.
   */
  readonly windowNeeds: bigint;
  /** The last instant the chain still redeems one of them, or null when there are none. */
  readonly redeemableUntil: Date | null;
}

export const NO_UNSETTLED_VOUCHERS: UnsettledVouchers = Object.freeze({
  count: 0,
  total: 0n,
  largest: 0n,
  windowNeeds: 0n,
  redeemableUntil: null,
});

/** Which cap a change would lower below what the unsettled vouchers need. */
export enum StrandReason {
  MAX_VOUCHER_AMOUNT = 'maxVoucherAmount',
  MAX_PER_WINDOW = 'maxPerWindow',
  VALID_UNTIL = 'validUntil',
  REVOKED = 'revoked',
}

/**
 * The caps a change LOWERS, and only those: a cap that stays or rises cannot
 * strand anything that fits today, and checking it would refuse a raise for a
 * shortfall the raise did not cause.
 */
export interface LoweredCaps {
  readonly maxVoucherAmount?: bigint;
  readonly maxPerWindow?: bigint;
  /** Unix seconds. */
  readonly validUntil?: bigint;
  readonly revoked?: boolean;
}

export interface CurrentCaps {
  readonly maxVoucherAmount: bigint;
  readonly maxPerWindow: bigint;
  /** Unix seconds; omitted for the escrow's limits, which do not lapse. */
  readonly validUntil?: bigint;
}

/** The caps of `next` that are lower than `current`. `current` null (a new grant) lowers nothing. */
export function loweredCaps(current: CurrentCaps | null, next: CurrentCaps): LoweredCaps {
  if (current === null) return {};
  const lowered: {
    maxVoucherAmount?: bigint;
    maxPerWindow?: bigint;
    validUntil?: bigint;
  } = {};
  if (next.maxVoucherAmount < current.maxVoucherAmount) {
    lowered.maxVoucherAmount = next.maxVoucherAmount;
  }
  if (next.maxPerWindow < current.maxPerWindow) lowered.maxPerWindow = next.maxPerWindow;
  if (
    next.validUntil !== undefined &&
    current.validUntil !== undefined &&
    next.validUntil < current.validUntil
  ) {
    lowered.validUntil = next.validUntil;
  }
  return lowered;
}

export function lowersAnything(lowered: LoweredCaps): boolean {
  return (
    lowered.maxVoucherAmount !== undefined ||
    lowered.maxPerWindow !== undefined ||
    lowered.validUntil !== undefined ||
    lowered.revoked === true
  );
}

/** The reasons the chain would refuse an unsettled voucher once `lowered` stands. Empty when none. */
export function strandedBy(unsettled: UnsettledVouchers, lowered: LoweredCaps): StrandReason[] {
  if (unsettled.count === 0) return [];
  const reasons: StrandReason[] = [];
  if (lowered.revoked) reasons.push(StrandReason.REVOKED);
  if (lowered.maxVoucherAmount !== undefined && unsettled.largest > lowered.maxVoucherAmount) {
    reasons.push(StrandReason.MAX_VOUCHER_AMOUNT);
  }
  if (lowered.maxPerWindow !== undefined && unsettled.windowNeeds > lowered.maxPerWindow) {
    reasons.push(StrandReason.MAX_PER_WINDOW);
  }
  if (
    lowered.validUntil !== undefined &&
    unsettled.redeemableUntil !== null &&
    Number(lowered.validUntil) * 1000 < unsettled.redeemableUntil.getTime()
  ) {
    reasons.push(StrandReason.VALID_UNTIL);
  }
  return reasons;
}
