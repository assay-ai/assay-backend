import {
  DEBT_VOIDED_PREFIX,
  PROVIDER_FORFEIT_PREFIX,
  UNCOLLECTED_PREFIX,
} from '../constants/voucher-redemption.constants';

/**
 * Whether a served (`SETTLED`) call's money was, or will be, collected from
 * the buyer — the one per-row predicate behind every buyer-facing "charged"
 * figure (`GET /tool-calls`, `GET /receipts/:id`), so the list and the receipt
 * cannot disagree about the same call (review 2026-10-15 #2, M4). The SQL twin
 * for aggregates is `NOT_COLLECTED_SQL` / `DEBT_OUTSTANDING_SQL` in
 * `payment-intent.repository.ts`.
 *
 * The platform never pays a provider, so every non-collected state is one in
 * which NOBODY was paid:
 *
 * - `PROVIDER_FORFEITED`: the provider caused the voucher to fail; the buyer's
 *   hold was released, the buyer is not charged.
 * - `DEBT_OUTSTANDING`: the voucher lapsed for a reason that is not the
 *   provider's; the buyer still owes it (the hold is open) and its paid calls
 *   are refused until it signs a replacement. Charged: the money is the buyer's
 *   to pay, and it is held.
 * - `WRITTEN_OFF`: an outstanding debt not settled within 30 days; the hold
 *   was released and the provider is not paid (uncollected, on the provider
 *   side). The buyer is not charged but STILL OWES it: its paid calls stay
 *   refused until it re-signs (H1 interim), so the receipts summary counts it
 *   under owed, never under not charged (final review M2). Once re-signed the
 *   row is `DEBT_OUTSTANDING` again until collected.
 * - `VOIDED`: a debt whose call was judged FAIL / REFUND / VOID after it had
 *   been settled as served and unverified; the hold was released, the buyer is
 *   not charged and nobody is paid (review-buyer-debt M2).
 *
 * A debt whose replacement voucher is being collected is still
 * `DEBT_OUTSTANDING`: the buyer owes it until the replacement lands.
 */
export enum CollectionState {
  /** Not a settled call, or settled and collected (or being collected) normally. */
  NORMAL = 'NORMAL',
  PROVIDER_FORFEITED = 'PROVIDER_FORFEITED',
  DEBT_OUTSTANDING = 'DEBT_OUTSTANDING',
  WRITTEN_OFF = 'WRITTEN_OFF',
  VOIDED = 'VOIDED',
}

/** The buyer-debt state a receipt or call row reports. */
export type DebtState = 'OUTSTANDING' | 'WRITTEN_OFF' | 'VOIDED' | null;

export interface CollectionInput {
  readonly redemptionLastError?: string | null;
  readonly redemptionLapsedAt?: Date | null;
  readonly holdReleasedAt?: Date | null;
}

export function collectionStateOf(intent: CollectionInput): CollectionState {
  const cause = intent.redemptionLastError ?? null;
  if (cause?.startsWith(PROVIDER_FORFEIT_PREFIX)) return CollectionState.PROVIDER_FORFEITED;
  if (cause?.startsWith(UNCOLLECTED_PREFIX)) return CollectionState.WRITTEN_OFF;
  if (cause?.startsWith(DEBT_VOIDED_PREFIX)) return CollectionState.VOIDED;
  if (intent.redemptionLapsedAt && !intent.holdReleasedAt) return CollectionState.DEBT_OUTSTANDING;
  return CollectionState.NORMAL;
}

/** Whether a `SETTLED` call is charged to the buyer: not forfeited, written off or voided. */
export function isChargedWhenSettled(intent: CollectionInput): boolean {
  const state = collectionStateOf(intent);
  return (
    state !== CollectionState.PROVIDER_FORFEITED &&
    state !== CollectionState.WRITTEN_OFF &&
    state !== CollectionState.VOIDED
  );
}

/**
 * The mark an upheld buyer report writes when it refunds a served call
 * (`voided:DISPUTE_UPHELD`, `call-dispute.ts`'s `DISPUTE_UPHELD_VOID_OUTCOME`).
 * The row is `VOIDED` like a late-verdict debt, so the money reads the same;
 * only the reason a buyer is told differs.
 */
const REFUNDED_BY_REPORT_MARK = `${DEBT_VOIDED_PREFIX}DISPUTE_UPHELD`;

/** A served call refunded because the buyer's report was upheld. */
export function isRefundedByReport(intent: CollectionInput): boolean {
  return intent.redemptionLastError === REFUNDED_BY_REPORT_MARK;
}

/**
 * A `SETTLED` call that was never collected and is not owed: the provider
 * forfeited it, or its debt was voided (a late verdict or an upheld report).
 * The per-row twin of the repository's `NOT_CHARGED_SETTLED_SQL`, and the
 * `notCollected` the withheld
 * definition reads.
 */
export function isNotCollected(intent: CollectionInput): boolean {
  const state = collectionStateOf(intent);
  return state === CollectionState.PROVIDER_FORFEITED || state === CollectionState.VOIDED;
}

export function debtStateOf(intent: CollectionInput): DebtState {
  switch (collectionStateOf(intent)) {
    case CollectionState.DEBT_OUTSTANDING:
      return 'OUTSTANDING';
    case CollectionState.WRITTEN_OFF:
      return 'WRITTEN_OFF';
    case CollectionState.VOIDED:
      return 'VOIDED';
    default:
      return null;
  }
}
