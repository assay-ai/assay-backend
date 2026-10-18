/**
 * Buyer call disputes (G3.B1) — the rules, as pure functions.
 *
 * ## Where an upheld refund's money comes from
 *
 * The platform never pays or owes a provider, and never pays a buyer out of its
 * own funds. A served call's payment is HELD for the dispute window before it
 * is the provider's ("redeem into hold", analysis §5): rail B's voucher is
 * redeemed into the escrow's `held[payer][seq]` (out of the buyer's balance);
 * rail A's provider credit is withheld in the ledger. So:
 *
 * 1. **Filed while the payment is held** (more than 60 s before
 *    `collectable_at`, or a rail-B call not redeemed yet) — `refund_guaranteed`:
 *    `dispute_outcome = 'OPEN'` keeps the collection job off it. Upheld:
 *    `refundHeld` puts it back in the buyer's escrow (rail A: the withheld
 *    credit is released) — one `HOLD_RELEASE`, nobody credited, a full refund.
 *    Rejected: collected at once.
 * 2. **Filed after the window**: a quality signal. A refund happens only if
 *    the money is uncollected for another reason — buyer debt (outstanding or
 *    written off) is voided through `PaymentIntentService.voidDebt`. A collected
 *    call is `NOT_REFUNDABLE`: nothing is booked.
 * 3. **Nobody was charged** (forfeited, voided): `NOT_CHARGED`. A held payment
 *    refunded because its provider was blocked was charged and refunded:
 *    `REFUNDED`, whatever the decision.
 * 4. **In flight** (a rail-B voucher about to be redeemed into the hold, a held
 *    payment past its window about to be collected, a debt's replacement being
 *    collected): the decision waits a minute.
 *
 * A held payment past the chain's 7-day timeout may be collected by anyone, in
 * the provider's favour; a refund is then impossible (`NOT_REFUNDABLE`).
 */

/** Why a buyer disputes a call — a small closed set, plus a free note. */
export enum CallDisputeReason {
  WRONG_DATA = 'WRONG_DATA',
  EMPTY_OR_GARBAGE = 'EMPTY_OR_GARBAGE',
  WRONG_FORMAT = 'WRONG_FORMAT',
  TOO_SLOW = 'TOO_SLOW',
  OTHER = 'OTHER',
}

export const CALL_DISPUTE_REASON_LABEL: Readonly<Record<CallDisputeReason, string>> = Object.freeze(
  {
    [CallDisputeReason.WRONG_DATA]: 'Wrong data',
    [CallDisputeReason.EMPTY_OR_GARBAGE]: 'Empty or garbage result',
    [CallDisputeReason.WRONG_FORMAT]: 'Wrong format',
    [CallDisputeReason.TOO_SLOW]: 'Too slow',
    [CallDisputeReason.OTHER]: 'Other',
  },
);

export enum CallDisputeDecision {
  UPHOLD = 'UPHOLD',
  REJECT = 'REJECT',
}

export enum RefundSource {
  /** Money that never reached the provider: a held voucher, or buyer debt. */
  UNCOLLECTED_EARNINGS = 'UNCOLLECTED_EARNINGS',
  NONE = 'NONE',
}

export enum RefundState {
  /** Decided; the ledger step has not landed yet. Deciding again finishes it. */
  PENDING = 'PENDING',
  REFUNDED = 'REFUNDED',
  NOT_CHARGED = 'NOT_CHARGED',
  /** Filed after the hold and the provider was paid: a quality signal only. */
  NOT_REFUNDABLE = 'NOT_REFUNDABLE',
}

/** The cause written on the intent when an upheld dispute voids its debt. */
export const DISPUTE_UPHELD_VOID_OUTCOME = 'DISPUTE_UPHELD';

export enum RefundPlanKind {
  /** A voucher the dispute held: release it, never redeem it. */
  RELEASE_HELD = 'RELEASE_HELD',
  VOID_DEBT = 'VOID_DEBT',
  NOT_CHARGED = 'NOT_CHARGED',
  COLLECTION_IN_PROGRESS = 'COLLECTION_IN_PROGRESS',
  /** The provider was paid. */
  COLLECTED = 'COLLECTED',
  /** The upheld void already landed (a retry). */
  ALREADY_REFUNDED = 'ALREADY_REFUNDED',
}

/** What {@link planRefund} reads off the intent. */
export interface RefundPlanInput {
  readonly status: string;
  readonly rail: string;
  readonly holdId: string | null;
  readonly holdReleasedAt: Date | null;
  readonly redemptionLastError: string | null;
  readonly redemptionLapsedAt: Date | null;
  readonly redemptionReplacedAt: Date | null;
  /** `OPEN` | `UPHELD` | `REJECTED` | null — see `payment_intents.dispute_outcome`. */
  readonly disputeOutcome?: string | null;
  /** `HELD` | `COLLECTED` | `REFUNDED` | null — see `payment_intents.held_status`. */
  readonly heldStatus?: string | null;
}

const RAIL_B = 'RAIL_B_VOUCHER';
const SETTLED = 'SETTLED';
const UPHELD_VOID_MARK = `voided:${DISPUTE_UPHELD_VOID_OUTCOME}`;

/** Where the money of a disputed call is now — see the file comment. */
export function planRefund(intent: RefundPlanInput): RefundPlanKind {
  if (intent.status !== SETTLED || !intent.holdId) return RefundPlanKind.NOT_CHARGED;

  const mark = intent.redemptionLastError ?? '';
  if (mark === UPHELD_VOID_MARK) return RefundPlanKind.ALREADY_REFUNDED;
  // A blocked provider's held payment refunded to the buyer (the provider
  // forfeits): the buyer WAS charged and has been refunded — not "not charged".
  if (mark.startsWith('provider_forfeit:') && intent.heldStatus === 'REFUNDED') {
    return RefundPlanKind.ALREADY_REFUNDED;
  }
  if (mark.startsWith('provider_forfeit:') || mark.startsWith('voided:')) {
    return RefundPlanKind.NOT_CHARGED;
  }

  if (intent.rail !== RAIL_B) {
    // Rail A: held in the ledger for the window, then committed.
    if (intent.heldStatus === 'HELD') {
      const disputed = intent.disputeOutcome === 'OPEN' || intent.disputeOutcome === 'UPHELD';
      return disputed ? RefundPlanKind.RELEASE_HELD : RefundPlanKind.COLLECTION_IN_PROGRESS;
    }
    return intent.holdReleasedAt ? RefundPlanKind.COLLECTED : RefundPlanKind.COLLECTION_IN_PROGRESS;
  }

  if (intent.redemptionLapsedAt) {
    // Buyer debt: outstanding (hold open) or written off (`uncollected:`).
    // A replacement voucher in flight may still land: wait for it.
    if (intent.redemptionReplacedAt) {
      return intent.holdReleasedAt
        ? RefundPlanKind.COLLECTED
        : RefundPlanKind.COLLECTION_IN_PROGRESS;
    }
    if (!intent.holdReleasedAt || mark.startsWith('uncollected:')) return RefundPlanKind.VOID_DEBT;
  }

  // The dispute hold (G3.B1): the payment is held, not yet the provider's.
  const disputed = intent.disputeOutcome === 'OPEN' || intent.disputeOutcome === 'UPHELD';
  if (intent.heldStatus === 'COLLECTED') return RefundPlanKind.COLLECTED;
  if (intent.heldStatus === 'HELD') {
    return disputed ? RefundPlanKind.RELEASE_HELD : RefundPlanKind.COLLECTION_IN_PROGRESS;
  }

  // Collected the old way: the hold committed with its redemption.
  if (intent.holdReleasedAt) return RefundPlanKind.COLLECTED;
  // A rail-B voucher about to be redeemed into the hold.
  return RefundPlanKind.COLLECTION_IN_PROGRESS;
}

/** The refund columns an upheld decision writes for a plan. `null` = cannot decide yet. */
export function refundColumnsFor(
  plan: RefundPlanKind,
): { source: RefundSource; state: RefundState } | null {
  switch (plan) {
    case RefundPlanKind.RELEASE_HELD:
    case RefundPlanKind.VOID_DEBT:
      return { source: RefundSource.UNCOLLECTED_EARNINGS, state: RefundState.PENDING };
    case RefundPlanKind.ALREADY_REFUNDED:
      return { source: RefundSource.UNCOLLECTED_EARNINGS, state: RefundState.REFUNDED };
    case RefundPlanKind.NOT_CHARGED:
      return { source: RefundSource.NONE, state: RefundState.NOT_CHARGED };
    case RefundPlanKind.COLLECTED:
      return { source: RefundSource.NONE, state: RefundState.NOT_REFUNDABLE };
    case RefundPlanKind.COLLECTION_IN_PROGRESS:
      return null;
  }
}

/** Whether a call settled at `settledAt` may still be disputed at `now`. */
export function withinFilingWindow(settledAt: Date, now: Date, windowMs: number): boolean {
  return now.getTime() - settledAt.getTime() <= windowMs;
}

/** One buyer's dispute history, as the abuse rule reads it. */
export interface BuyerDisputeHistory {
  /** Filed in the last 24 hours. */
  readonly filedLastDay: number;
  /** Decided in the last 30 days. */
  readonly upheldLast30Days: number;
  readonly rejectedLast30Days: number;
}

export interface FilingLimit {
  readonly limit: number;
  /** The buyer's disputes are mostly rejected: the tighter limit applies. */
  readonly flagged: boolean;
}

export function isFlaggedBuyer(
  history: Pick<BuyerDisputeHistory, 'upheldLast30Days' | 'rejectedLast30Days'>,
  rejectedThreshold: number,
): boolean {
  return (
    history.rejectedLast30Days >= rejectedThreshold &&
    history.rejectedLast30Days > history.upheldLast30Days
  );
}

export function filingLimitFor(
  history: BuyerDisputeHistory,
  config: {
    readonly maxFilingsPerDay: number;
    readonly abuseMaxFilingsPerDay: number;
    readonly abuseRejectedThreshold: number;
  },
): FilingLimit {
  const flagged = isFlaggedBuyer(history, config.abuseRejectedThreshold);
  return { limit: flagged ? config.abuseMaxFilingsPerDay : config.maxFilingsPerDay, flagged };
}

/** Whole units (decimal string) to minor units of an asset with `decimals`. */
export function unitsToMinor(units: string, decimals: number): bigint {
  const [whole, fraction = ''] = units.split('.');
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

/**
 * Whether an upheld decision owing `amountMinor` (of an asset with `decimals`)
 * needs a second operator: at or above `thresholdUnits` whole units.
 */
export function needsSecondOperator(
  amountMinor: string,
  decimals: number,
  thresholdUnits: string,
): boolean {
  return BigInt(amountMinor) >= unitsToMinor(thresholdUnits, decimals);
}

/**
 * A JSON body cut to `maxBytes` of its serialized form. Returned as is when it
 * fits; otherwise as a marker with the head of the serialized text, so a
 * decision can still read what the call returned.
 */
export function boundedBody(body: unknown, maxBytes: number): unknown {
  if (body === undefined || body === null) return null;
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return body;
  return {
    truncated: true,
    bytes: Buffer.byteLength(text, 'utf8'),
    head: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'),
  };
}
