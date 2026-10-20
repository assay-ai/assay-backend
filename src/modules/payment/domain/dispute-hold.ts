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
 * Whether a buyer report filed at `now` would be guaranteed a full refund if
 * upheld (G3.B1), for the receipt's read-only `refundableIfReportedNow`
 * (wave-1 audit I1). It mirrors, and does not gate, the filing:
 * `CallDisputeService.file` decides with its rail-B `holdLive` check and the
 * `UPDATE` in `PaymentIntentRepository.holdForDispute`. An integration test
 * (`call-disputes.integration.spec.ts`) files in every state and checks the
 * two answers agree, so a drift either way fails it.
 *
 * - Rail B needs the escrow hold live on the call's chain (`holdLive`); rail
 *   A's hold is the ledger's, so `holdLive` is not read for it.
 * - The call is served, its hold still open, and no report holds it yet.
 * - Either the payment is held and more than `guardSeconds` before
 *   `collectableAt`, or (rail B) served and not redeemed yet: it is redeemed
 *   into the hold as usual, and a full window starts then.
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
