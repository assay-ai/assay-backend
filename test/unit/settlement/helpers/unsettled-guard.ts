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
 * is what every read answers, and the calls are recorded. Each hold gets its
 * own pause id (`pause-1`, `pause-2`, ...), as the table's rows do.
 */
export function guardOver(
  totals: UnsettledVoucherTotals = NO_UNSETTLED_TOTALS,
  config?: Record<string, string>,
  /** Whether the payer's escrow has the tighten delay (D-21); the guard then stands down. */
  tightenDelay = false,
) {
  let holds = 0;
  const repository = {
    unsettledVouchers: jest.fn(async () => totals),
    holdVoucherAdmission: jest.fn(async () => ({ pauseId: `pause-${++holds}`, totals: [totals] })),
    landVoucherAdmissionPause: jest.fn(async () => undefined),
    releaseVoucherAdmissionPause: jest.fn(async () => undefined),
    assertAdmissionPauseSchema: jest.fn(async () => undefined),
  };
  const configService = config ? { get: (key: string) => config[key] } : undefined;
  return {
    guard: new UnsettledVoucherGuard(repository as never, configService as never, {
      holdsTightening: async () => tightenDelay,
    }),
    repository,
  };
}
