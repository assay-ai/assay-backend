import { PaymentRail } from '../ports/payment.types';

/** The `payment_intents` columns that decide whether a report is refund-guaranteed. */
export interface DisputeHoldFacts {
  readonly status: string;
  readonly rail: string;
  readonly holdId: string | null;
  readonly holdReleasedAt: Date | null;
  readonly disputeOutcome: string | null;
  readonly heldStatus: string | null;
  readonly collectableAt: Date | null;
  readonly redemptionLapsedAt: Date | null;
  readonly redemptionLastError: string | null;
}

/**
 * Whether a buyer report filed at `now` is guaranteed a full refund if upheld
 * (G3.B1). The one predicate behind both the filing's `refundGuaranteed`
 * (`CallDisputeService.file`, through `PaymentIntentRepository.holdForDispute`)
 * and the receipt's read-only `refundableIfReportedNow`, so the promise shown
 * before filing cannot drift from what filing grants (wave-1 audit I1).
 *
 * - Rail B needs the escrow hold live on the call's chain (`holdLive`); rail
 *   A's hold is the ledger's, so `holdLive` is not read for it.
 * - The call is served, its hold still open, and no report holds it yet.
 * - Either the payment is held and more than `guardSeconds` before
 *   `collectableAt`, or (rail B) served and not redeemed yet: it is redeemed
 *   into the hold as usual, and a full window starts then.
 *
 * `holdForDispute` keeps the same conditions in its `UPDATE` as well, so a
 * disagreement can only withhold a guarantee, never grant one.
 */
export function refundGuaranteedIfReported(
  call: DisputeHoldFacts,
  context: { readonly holdLive: boolean; readonly now: Date; readonly guardSeconds: number },
): boolean {
  if (call.rail === PaymentRail.RAIL_B_VOUCHER && !context.holdLive) return false;
  if (call.status !== 'SETTLED') return false;
  if (call.holdId === null || call.holdReleasedAt !== null) return false;
  if (call.disputeOutcome !== null) return false;
  if (call.heldStatus === 'HELD') {
    return (
      call.collectableAt !== null &&
      call.collectableAt.getTime() - context.guardSeconds * 1000 > context.now.getTime()
    );
  }
  return (
    call.heldStatus === null &&
    call.rail === PaymentRail.RAIL_B_VOUCHER &&
    call.redemptionLapsedAt === null &&
    call.redemptionLastError === null
  );
}
