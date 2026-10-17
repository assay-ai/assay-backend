/**
 * Buyer call disputes (G3.B1) — the rules, as pure functions.
 *
 * ## Where an upheld refund's money comes from
 *
 * The platform never pays or owes a provider, and never pays a buyer out of its
 * own funds. A paid call's money only ever moves from the buyer's escrow to the
 * provider, by the voucher's redemption. So the refund depends on where the
 * money is when the dispute is decided ({@link planRefund}):
 *
 * 1. **The provider was never paid** — the call is buyer debt (its voucher
 *    lapsed, outstanding or written off). The refund is the provider's
 *    uncollected earnings: the debt is voided through the existing
 *    `PaymentIntentService.voidDebt` — the buyer's hold is released (one
 *    `HOLD_RELEASE`; nothing if a write-off already released it), nobody is
 *    credited, and the buyer no longer owes it. `UNCOLLECTED_EARNINGS`.
 * 2. **Nobody was charged** — forfeited by the provider or voided already:
 *    nothing to refund. `NONE` / `NOT_CHARGED`.
 * 3. **Collection still in flight** — a rail-B voucher still awaiting its
 *    redemption (minutes), or a debt's replacement voucher being collected. The
 *    decision waits: releasing a hold whose voucher may land on chain would
 *    take the buyer's escrow AND hand it back in the books.
 * 4. **The provider was paid** — the voucher was redeemed (or a legacy rail-A
 *    call was credited). The money is the provider's, on chain; only its stake
 *    can return it, and only through the on-chain slash with its timelock, the
 *    provider's on-chain dispute and the arbiter. The decision records a claim
 *    on the provider's stake (`PROVIDER_STAKE` / `STAKE_CLAIM_OPEN`) and books
 *    nothing: no ledger credit to the buyer without money behind it (that would
 *    be a platform liability), no debit to the provider.
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
  UNCOLLECTED_EARNINGS = 'UNCOLLECTED_EARNINGS',
  PROVIDER_STAKE = 'PROVIDER_STAKE',
  NONE = 'NONE',
}

export enum RefundState {
  /** Decided; the ledger step has not landed yet. Deciding again finishes it. */
  PENDING = 'PENDING',
  REFUNDED = 'REFUNDED',
  NOT_CHARGED = 'NOT_CHARGED',
  STAKE_CLAIM_OPEN = 'STAKE_CLAIM_OPEN',
}

/** The cause written on the intent when an upheld dispute voids its debt. */
export const DISPUTE_UPHELD_VOID_OUTCOME = 'DISPUTE_UPHELD';

export enum RefundPlanKind {
  VOID_DEBT = 'VOID_DEBT',
  NOT_CHARGED = 'NOT_CHARGED',
  COLLECTION_IN_PROGRESS = 'COLLECTION_IN_PROGRESS',
  STAKE_CLAIM = 'STAKE_CLAIM',
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
    return intent.holdReleasedAt
      ? RefundPlanKind.STAKE_CLAIM
      : RefundPlanKind.COLLECTION_IN_PROGRESS;
  }

  if (intent.redemptionLapsedAt) {
    // Buyer debt: outstanding (hold open) or written off (`uncollected:`).
    // A replacement voucher in flight may still land: wait for it.
    if (intent.redemptionReplacedAt) {
      return intent.holdReleasedAt
        ? RefundPlanKind.STAKE_CLAIM
        : RefundPlanKind.COLLECTION_IN_PROGRESS;
    }
    if (!intent.holdReleasedAt || mark.startsWith('uncollected:')) return RefundPlanKind.VOID_DEBT;
  }

  // Awaiting redemption, or redeemed (the hold committed with its signature).
  return intent.holdReleasedAt ? RefundPlanKind.STAKE_CLAIM : RefundPlanKind.COLLECTION_IN_PROGRESS;
}

/** The refund columns an upheld decision writes for a plan. `null` = cannot decide yet. */
export function refundColumnsFor(
  plan: RefundPlanKind,
): { source: RefundSource; state: RefundState } | null {
  switch (plan) {
    case RefundPlanKind.VOID_DEBT:
      return { source: RefundSource.UNCOLLECTED_EARNINGS, state: RefundState.PENDING };
    case RefundPlanKind.ALREADY_REFUNDED:
      return { source: RefundSource.UNCOLLECTED_EARNINGS, state: RefundState.REFUNDED };
    case RefundPlanKind.NOT_CHARGED:
      return { source: RefundSource.NONE, state: RefundState.NOT_CHARGED };
    case RefundPlanKind.STAKE_CLAIM:
      return { source: RefundSource.PROVIDER_STAKE, state: RefundState.STAKE_CLAIM_OPEN };
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
