import { HELD } from '@modules/payment/constants/collection-hold.constants';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { PaymentIntentStatus, VoucherFormat } from '@modules/payment/ports/payment.types';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';

/**
 * W2 rerun R-5: a channel refund `ChannelRefundService.refund` held back (an
 * earlier send unresolved, or its drop being confirmed) is a retryable "not
 * sent yet", not a state-machine refusal ("Illegal payment intent transition:
 * SETTLED → SETTLED").
 */
describe('PaymentIntentService.refundHeldForDispute — a channel refund not sent yet (R-5)', () => {
  function build(reason: string) {
    const channelRefunds = {
      refund: jest.fn(async () => ({ kind: 'NOT_FOUND', reason })),
    };
    const service = new PaymentIntentService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      null,
      null,
      null,
      null,
      null,
      channelRefunds as never,
    );
    jest.spyOn(service, 'findById').mockResolvedValue({
      id: 'intent-1',
      organizationId: 'org-1',
      status: PaymentIntentStatus.SETTLED,
      holdId: 'hold-1',
      heldStatus: HELD,
      voucherFormat: VoucherFormat.CHANNEL,
      channelRowId: 'lane-1',
      channelSettlementId: null,
      holdReleasedAt: null,
      price: { amount: '1000', asset: 'eip155:46630/erc20:0xabc', decimals: 6 },
    } as never);
    return { service, channelRefunds };
  }

  it('throws PAYMENT_CHANNEL_REFUND_NOT_SENT with the reason, never an illegal transition', async () => {
    const reason = 'an earlier refund of this call is unresolved';
    const { service, channelRefunds } = build(reason);
    const error = (await service
      .refundHeldForDispute('org-1', 'intent-1', 'dispute_upheld')
      .catch((e: unknown) => e)) as Error & { errorCode: string };
    expect(channelRefunds.refund).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ errorCode: PaymentErrorCode.PAYMENT_CHANNEL_REFUND_NOT_SENT });
    expect(error.message).toBe(`channel refund not sent yet: ${reason}; retried [intent intent-1]`);
    expect(error.message).not.toMatch(/Illegal payment intent transition/);
  });
});
