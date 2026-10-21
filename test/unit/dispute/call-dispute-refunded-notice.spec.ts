import { DisputeEntity } from '@database/postgres/entities/dispute.entity';
import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { DEFAULT_CALL_DISPUTE_CONFIG } from '@modules/dispute/constants/call-dispute.config';
import { CallDisputeService } from '@modules/dispute/services/call-dispute.service';
import { NotificationEvent } from '@modules/notification/ports/notification.port';

/**
 * BUG-OPS-CASES-05: an upheld dispute's refund landing tells the buyer
 * `call_dispute.refunded`, once, under the key the blocked-provider refund uses.
 */
describe('CallDisputeService.settleRefund: the refunded notice', () => {
  const HELD_INTENT = {
    id: 'intent-1',
    organizationId: 'buyer-org',
    status: 'SETTLED',
    rail: 'RAIL_B_VOUCHER',
    holdId: 'hold-1',
    holdReleasedAt: null,
    redemptionLastError: null,
    redemptionLapsedAt: null,
    redemptionReplacedAt: null,
    disputeOutcome: 'UPHELD',
    heldStatus: 'HELD',
    priceAmount: '10000',
    settledAmount: '10000',
  } as unknown as PaymentIntentEntity;

  function dispute(refundState: string): DisputeEntity {
    return {
      id: 'dispute-1',
      organizationId: 'buyer-org',
      intentId: 'intent-1',
      respondentProviderId: 'provider-org',
      state: 'UPHELD',
      refundState,
      refundAmount: null,
    } as unknown as DisputeEntity;
  }

  function build(options: {
    intents: PaymentIntentEntity[];
    refund?: jest.Mock;
    voidDebt?: jest.Mock;
  }) {
    const notified: Array<Record<string, unknown>> = [];
    const intents = [...options.intents];
    const paymentIntents = {
      findOneBy: jest.fn(async () => (intents.length > 1 ? intents.shift() : intents[0])),
      recordHeldFailure: jest.fn(),
    };
    const service = new CallDisputeService(
      { query: jest.fn().mockResolvedValue([[], 1]) } as never,
      {} as never,
      paymentIntents as never,
      {} as never,
      {
        refundHeldForDispute: options.refund ?? jest.fn().mockResolvedValue('REFUNDED'),
        voidDebt: options.voidDebt ?? jest.fn(),
      } as never,
      {} as never,
      {} as never,
      { notify: async (request: Record<string, unknown>) => void notified.push(request) } as never,
      DEFAULT_CALL_DISPUTE_CONFIG,
      {} as never,
    );
    const states = [dispute('PENDING'), dispute('REFUNDED')];
    jest
      .spyOn(service, 'requireAny')
      .mockImplementation(async () => (states.length > 1 ? states.shift() : states[0])!);
    return { service, notified };
  }

  it('tells the buyer once refundHeld has refunded the held payment', async () => {
    const refunded = {
      ...HELD_INTENT,
      heldStatus: 'REFUNDED',
      redemptionLastError: 'voided:DISPUTE_UPHELD',
    } as unknown as PaymentIntentEntity;
    const { service, notified } = build({ intents: [HELD_INTENT, refunded] });

    const after = await service.settleRefund('dispute-1', { chain: true });

    expect(after.refundState).toBe('REFUNDED');
    expect(notified).toEqual([
      expect.objectContaining({
        organizationId: 'buyer-org',
        event: NotificationEvent.CALL_DISPUTE_REFUNDED,
        title: 'Your disputed call was refunded',
        subjectId: 'dispute-1',
        dedupeKey: `${NotificationEvent.CALL_DISPUTE_REFUNDED}:dispute-1`,
        payload: expect.objectContaining({ role: 'buyer', refundState: 'REFUNDED' }),
      }),
    ]);
  });

  it('tells the buyer when the collection job refunded it first (a retry books it)', async () => {
    const refunded = {
      ...HELD_INTENT,
      heldStatus: 'REFUNDED',
      redemptionLastError: 'voided:DISPUTE_UPHELD',
    } as unknown as PaymentIntentEntity;
    const refund = jest.fn();
    const { service, notified } = build({ intents: [refunded], refund });

    await service.settleRefund('dispute-1', { chain: true });

    expect(refund).not.toHaveBeenCalled();
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ event: NotificationEvent.CALL_DISPUTE_REFUNDED });
  });

  it('says nothing while the refund has not landed', async () => {
    const { service, notified } = build({
      intents: [HELD_INTENT],
      refund: jest.fn().mockRejectedValue(new Error('rpc down')),
    });

    const after = await service.settleRefund('dispute-1', { chain: true });

    expect(after.refundState).toBe('PENDING');
    expect(notified).toEqual([]);
  });
});
