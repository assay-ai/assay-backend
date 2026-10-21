import { DisputeEntity } from '@database/postgres/entities/dispute.entity';
import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { DEFAULT_CALL_DISPUTE_CONFIG } from '@modules/dispute/constants/call-dispute.config';
import { CallDisputeService } from '@modules/dispute/services/call-dispute.service';
import { NOTIFICATION_CATALOGUE } from '@modules/notification/constants/notification-catalogue';
import {
  NotificationAggregation,
  NotificationEvent,
} from '@modules/notification/ports/notification.port';

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
    // The `refund_state = 'PENDING'` compare-and-swap: only the first UPDATE
    // moves the row (`RETURNING "id"`); every read after it sees REFUNDED.
    let pending = true;
    const query = jest.fn(async () => {
      if (!pending) return [[], 0];
      pending = false;
      return [[{ id: 'dispute-1' }], 1];
    });
    const service = new CallDisputeService(
      { query } as never,
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
    jest
      .spyOn(service, 'requireAny')
      .mockImplementation(async () => dispute(pending ? 'PENDING' : 'REFUNDED'));
    return { service, notified, query };
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

  it('sends one notice when two runs settle the same dispute at once (review I1)', async () => {
    const refunded = {
      ...HELD_INTENT,
      heldStatus: 'REFUNDED',
      redemptionLastError: 'voided:DISPUTE_UPHELD',
    } as unknown as PaymentIntentEntity;
    const { service, notified, query } = build({ intents: [refunded] });

    // The operator's decision and the refund job, both reading PENDING.
    const [a, b] = await Promise.all([
      service.settleRefund('dispute-1'),
      service.settleRefund('dispute-1', { chain: true }),
    ]);

    expect(query).toHaveBeenCalledTimes(2);
    expect([a.refundState, b.refundState]).toEqual(['REFUNDED', 'REFUNDED']);
    expect(notified).toHaveLength(1);
  });

  it('says nothing when its UPDATE moved no row (another run booked it)', async () => {
    const refunded = {
      ...HELD_INTENT,
      heldStatus: 'REFUNDED',
      redemptionLastError: 'voided:DISPUTE_UPHELD',
    } as unknown as PaymentIntentEntity;
    const { service, notified, query } = build({ intents: [refunded] });
    query.mockResolvedValueOnce([[], 0]);

    await service.settleRefund('dispute-1', { chain: true });

    expect(notified).toEqual([]);
  });

  it('announces the decision under one key per side, the same at the decision and at the refund (BUG-RETEST-R5a-01)', async () => {
    const { service, notified } = build({ intents: [HELD_INTENT] });

    await service.announceDecision(dispute('PENDING'));
    await service.announceDecision(dispute('REFUNDED'));

    const keys = notified.map((n) => [n.organizationId, n.event, n.dedupeKey]);
    expect(keys).toEqual([
      [
        'buyer-org',
        NotificationEvent.CALL_DISPUTE_DECIDED,
        'call_dispute.decided:dispute-1:buyer-org:buyer',
      ],
      [
        'provider-org',
        NotificationEvent.CALL_DISPUTE_DECIDED,
        'call_dispute.decided:dispute-1:provider-org:provider',
      ],
      [
        'buyer-org',
        NotificationEvent.CALL_DISPUTE_DECIDED,
        'call_dispute.decided:dispute-1:buyer-org:buyer',
      ],
      [
        'provider-org',
        NotificationEvent.CALL_DISPUTE_DECIDED,
        'call_dispute.decided:dispute-1:provider-org:provider',
      ],
    ]);
  });

  it('keeps call_dispute.decided a once-per-key notice in the catalogue', () => {
    expect(NOTIFICATION_CATALOGUE[NotificationEvent.CALL_DISPUTE_DECIDED].aggregation).toBe(
      NotificationAggregation.ONCE,
    );
    expect(NOTIFICATION_CATALOGUE[NotificationEvent.CALL_DISPUTE_REFUNDED].aggregation).toBe(
      NotificationAggregation.ONCE,
    );
  });
});
