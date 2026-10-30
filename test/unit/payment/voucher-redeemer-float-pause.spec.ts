import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import { BaseError } from '@shared/errors/base.error';

import { offerSolanaRailBInThisSuite } from '../helpers/solana-rail-b';

import { createVoucherHarness } from './helpers/voucher-harness';

/**
 * `VoucherService.redeem` refuses a new paid call while the chain's EVM
 * redeemer float is critical (2026-10-29: the redeemer ran dry and admitted
 * vouchers lapsed into buyer debt). The gate itself, and its fail-open rules,
 * are `evm-redeemer-float.gate.spec.ts`.
 */
describe('VoucherService — paused on a dry redeemer', () => {
  offerSolanaRailBInThisSuite();

  it('refuses with a retryable 503 carrying retryAfter, and reserves nothing', async () => {
    const isPaused = jest.fn(async () => true);
    const harness = createVoucherHarness(undefined, { isPaused });
    const { input } = harness.voucherFor();

    const error = await harness.service.redeem(input).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(BaseError);
    expect((error as BaseError).errorCode).toBe(PaymentErrorCode.PAYMENT_SETTLEMENT_GAS_PAUSED);
    expect((error as BaseError).statusCode).toBe(503);
    expect((error as { context?: Record<string, unknown> }).context).toEqual({ retryAfter: 60 });
    expect((error as Error).message).toContain(
      'Paid calls are paused while the platform tops up its settlement gas; try again shortly.',
    );
    expect(isPaused).toHaveBeenCalledWith(input.chainId);
    expect(harness.intents.created).toHaveLength(0);
  });

  it('admits the same voucher once the flag clears', async () => {
    let paused = true;
    const harness = createVoucherHarness(undefined, { isPaused: async () => paused });
    const { input } = harness.voucherFor();
    await expect(harness.service.redeem(input)).rejects.toBeInstanceOf(BaseError);

    paused = false;
    const intent = await harness.service.redeem(input);
    expect(intent.status).toBe(PaymentIntentStatus.FUNDS_SECURED);
  });
});
