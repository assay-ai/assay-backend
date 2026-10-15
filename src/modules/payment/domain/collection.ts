import {
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
 *   was released, the buyer is not charged and the provider is not paid.
 */
export enum CollectionState {
  /** Not a settled call, or settled and collected (or being collected) normally. */
  NORMAL = 'NORMAL',
  PROVIDER_FORFEITED = 'PROVIDER_FORFEITED',
  DEBT_OUTSTANDING = 'DEBT_OUTSTANDING',
  WRITTEN_OFF = 'WRITTEN_OFF',
}

/** The buyer-debt state a receipt or call row reports. */
export type DebtState = 'OUTSTANDING' | 'WRITTEN_OFF' | null;

export interface CollectionInput {
  readonly redemptionLastError?: string | null;
  readonly redemptionLapsedAt?: Date | null;
  readonly holdReleasedAt?: Date | null;
}

export function collectionStateOf(intent: CollectionInput): CollectionState {
  const cause = intent.redemptionLastError ?? null;
  if (cause?.startsWith(PROVIDER_FORFEIT_PREFIX)) return CollectionState.PROVIDER_FORFEITED;
  if (cause?.startsWith(UNCOLLECTED_PREFIX)) return CollectionState.WRITTEN_OFF;
  if (intent.redemptionLapsedAt && !intent.holdReleasedAt) return CollectionState.DEBT_OUTSTANDING;
  return CollectionState.NORMAL;
}

/** Whether a `SETTLED` call is charged to the buyer: not forfeited and not written off. */
export function isChargedWhenSettled(intent: CollectionInput): boolean {
  const state = collectionStateOf(intent);
  return state !== CollectionState.PROVIDER_FORFEITED && state !== CollectionState.WRITTEN_OFF;
}

export function debtStateOf(intent: CollectionInput): DebtState {
  switch (collectionStateOf(intent)) {
    case CollectionState.DEBT_OUTSTANDING:
      return 'OUTSTANDING';
    case CollectionState.WRITTEN_OFF:
      return 'WRITTEN_OFF';
    default:
      return null;
  }
}
