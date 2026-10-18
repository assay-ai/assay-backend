/**
 * Buyer call disputes (G3.B1) — the rules, as pure functions.
 *
 * ## Where an upheld refund's money comes from
 *
 * The platform never pays or owes a provider, and never pays a buyer out of its
 * own funds. A paid call's money only ever moves from the buyer's escrow to the
 * provider, by the voucher's redemption — and that redemption waits for the
 * dispute hold (`payment_intents.collectable_at`, see
 * `payment/constants/collection-hold.constants.ts`). So:
 *
 * 1. **Filed inside the hold** (`refund_guaranteed`): the voucher is set aside
 *    (`dispute_outcome = 'OPEN'`) before anything reached the chain, and stays
 *    out of the redemption queue until the decision. Upheld: the hold is
 *    released and the voucher closed for good (`PaymentIntentService.
 *    releaseDisputedHold`) — one `HOLD_RELEASE`, nobody credited, a full
 *    refund. Rejected: it goes back to the queue and is collected normally (or,
 *    if the voucher died during the dispute, becomes buyer debt through the
 *    existing flow).
 * 2. **Filed after the hold**: a quality signal. A refund happens only if the
 *    money is still uncollected for another reason — buyer debt (outstanding or
 *    written off) is voided through `PaymentIntentService.voidDebt`. A
 *    collected call is `NOT_REFUNDABLE`: nothing is booked.
 * 3. **Nobody was charged** (forfeited, voided): `NOT_CHARGED`.
 * 4. **Collection in flight** (a voucher past its hold, not yet redeemed; a
 *    debt's replacement being collected): the decision waits a few minutes —
 *    releasing a hold whose voucher may land would take the buyer's escrow AND
 *    hand it back in the books.
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
  readonly redemptionTxRefs?: readonly string[] | null;
}

const RAIL_B = 'RAIL_B_VOUCHER';
const SETTLED = 'SETTLED';
const UPHELD_VOID_MARK = `voided:${DISPUTE_UPHELD_VOID_OUTCOME}`;

/** Where the money of a disputed call is now — see the file comment. */
export function planRefund(intent: RefundPlanInput): RefundPlanKind {
  if (intent.status !== SETTLED || !intent.holdId) return RefundPlanKind.NOT_CHARGED;

  const mark = intent.redemptionLastError ?? '';
  if (mark === UPHELD_VOID_MARK) return RefundPlanKind.ALREADY_REFUNDED;
  if (mark.startsWith('provider_forfeit:') || mark.startsWith('voided:')) {
    return RefundPlanKind.NOT_CHARGED;
  }

  if (intent.rail !== RAIL_B) {
    // Rail A commits inline at settle; an open hold is a repair still owed.
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

  // Redeemed: the hold committed with its signature.
  if (intent.holdReleasedAt) return RefundPlanKind.COLLECTED;

  // Held by a dispute filed inside the hold, and never sent to the chain.
  const held = intent.disputeOutcome === 'OPEN' || intent.disputeOutcome === 'UPHELD';
  if (held && (intent.redemptionTxRefs ?? []).length === 0 && mark === '') {
    return RefundPlanKind.RELEASE_HELD;
  }
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

/** Whether an upheld decision owing `amountMinor` needs a second operator. */
export function needsSecondOperator(amountMinor: string, thresholdMinor: string): boolean {
  return BigInt(amountMinor) >= BigInt(thresholdMinor);
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
