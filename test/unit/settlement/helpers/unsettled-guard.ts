import { UnsettledVoucherTotals } from '@database/postgres/repositories/payment-intent.repository';
import { UnsettledVoucherGuard } from '@modules/settlement/services/unsettled-voucher-guard.service';

export const NO_UNSETTLED_TOTALS: UnsettledVoucherTotals = {
  count: 0,
  total: 0n,
  largest: 0n,
  redeemableUntil: null,
  redeemedSince: 0n,
};

/**
 * The real guard over a stand-in for `payment_intents` (BUG-D1-07): `totals`
 * is what every read answers, and the calls are recorded.
 */
export function guardOver(totals: UnsettledVoucherTotals = NO_UNSETTLED_TOTALS) {
  const repository = {
    unsettledVouchers: jest.fn(async () => totals),
    holdVoucherAdmission: jest.fn(async () => [totals]),
    resumeVoucherAdmission: jest.fn(async () => undefined),
  };
  return { guard: new UnsettledVoucherGuard(repository as never), repository };
}
