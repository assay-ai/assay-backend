import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { DisputeRepository } from '@database/postgres/repositories/dispute.repository';
import { DEFAULT_CALL_DISPUTE_CONFIG } from '@modules/dispute/constants/call-dispute.config';
import {
  HOLD_LIVE_TIMEOUT_MS,
  RefundEligibilityService,
} from '@modules/dispute/services/refund-eligibility.service';
import { HeldPaymentsPort } from '@modules/payment/ports/held-payments.port';

const NOW = new Date('2026-10-18T12:00:00.000Z');
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

function call(overrides: Partial<PaymentIntentEntity> = {}): PaymentIntentEntity {
  return {
    id: 'intent-1',
    organizationId: 'buyer',
    providerId: 'provider',
    status: 'SETTLED',
    callClass: 'PAID',
    priceAmount: '1000',
    rail: 'RAIL_B_VOUCHER',
    assetId: 'eip155:46630/erc20:0x1',
    holdId: 'hold-1',
    holdReleasedAt: null,
    disputeOutcome: null,
    heldStatus: 'HELD',
    collectableAt: at(1800),
    redemptionLapsedAt: null,
    redemptionLastError: null,
    updatedAt: at(-600),
    ...overrides,
  } as PaymentIntentEntity;
}

function build(held: Partial<HeldPaymentsPort> = { holdLive: async () => true }, decided = null) {
  const disputes = {
    findOneBy: jest.fn().mockResolvedValue(decided),
    find: jest.fn().mockResolvedValue([]),
  };
  const service = new RefundEligibilityService(
    disputes as unknown as DisputeRepository,
    DEFAULT_CALL_DISPUTE_CONFIG,
    held as HeldPaymentsPort,
  );
  return { service, disputes };
}

describe('RefundEligibilityService (wave-1 audit I1, review m1)', () => {
  it('a held call: refundable until collectableAt − 60 s', async () => {
    const { service } = build();
    expect(await service.ofCall(call(), at(-600), NOW)).toEqual({
      refundable: true,
      until: at(1800 - 60),
    });
  });

  it('a rail-B voucher not redeemed yet: refundable, with no end known', async () => {
    const { service } = build();
    expect(
      await service.ofCall(call({ heldStatus: null, collectableAt: null }), at(-600), NOW),
    ).toEqual({ refundable: true, until: null });
  });

  it('runs the cheap check first: no chain or dispute read when the row already says no', async () => {
    const holdLive = jest.fn(async () => true);
    const { service, disputes } = build({ holdLive });
    expect(await service.ofCall(call({ holdReleasedAt: at(-1) }), at(-600), NOW)).toEqual({
      refundable: false,
      until: null,
    });
    expect(holdLive).not.toHaveBeenCalled();
    expect(disputes.findOneBy).not.toHaveBeenCalled();
  });

  it('rail A never asks the chain', async () => {
    const holdLive = jest.fn(async () => false);
    const { service } = build({ holdLive });
    expect(
      (await service.ofCall(call({ rail: 'RAIL_A_PER_CALL' }), at(-600), NOW)).refundable,
    ).toBe(true);
    expect(holdLive).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<HeldPaymentsPort> | null]>([
    ['no port', null],
    ['the hold is not live', { holdLive: async () => false }],
    [
      'the chain throws',
      {
        holdLive: async () => {
          throw new Error('rpc down');
        },
      },
    ],
  ])('rail B promises nothing with %s', async (_, held) => {
    const { service } = build(held);
    expect(await service.ofCall(call(), at(-600), NOW)).toEqual({ refundable: false, until: null });
  });

  it('rail B promises nothing when the chain does not answer in time', async () => {
    jest.useFakeTimers();
    try {
      const { service } = build({ holdLive: () => new Promise<boolean>(() => undefined) });
      const answer = service.ofCall(call(), at(-600), NOW);
      await jest.advanceTimersByTimeAsync(HOLD_LIVE_TIMEOUT_MS);
      expect(await answer).toEqual({ refundable: false, until: null });
    } finally {
      jest.useRealTimers();
    }
  });

  it('a call already decided, outside the filing window, free or the buyer’s own: not refundable', async () => {
    expect(
      (await build(undefined, { id: 'd' } as never).service.ofCall(call(), at(-600), NOW))
        .refundable,
    ).toBe(false);
    const { service } = build();
    expect((await service.ofCall(call(), at(-8 * 24 * 3600), NOW)).refundable).toBe(false);
    expect((await service.ofCall(call({ priceAmount: '0' }), at(-600), NOW)).refundable).toBe(
      false,
    );
    expect((await service.ofCall(call({ providerId: 'buyer' }), at(-600), NOW)).refundable).toBe(
      false,
    );
  });
});

describe('RefundEligibilityService.ofCalls (B7 review m2, nit 2)', () => {
  it('answers a page with one dispute query and one chain read per asset, as ofCall would', async () => {
    const holdLive = jest.fn(async () => true);
    const { service, disputes } = build({ holdLive });
    disputes.find.mockResolvedValue([
      { intentId: 'decided', state: 'REJECTED' },
      { intentId: 'open', state: 'OPEN' },
    ]);
    const calls = ['plain', 'decided', 'open'].map((id) => ({
      intent: call({ id }),
      settledAt: at(-600),
    }));
    calls.push({ intent: call({ id: 'released', holdReleasedAt: at(-1) }), settledAt: at(-600) });

    const answers = await service.ofCalls(calls, NOW);

    expect(disputes.find).toHaveBeenCalledTimes(1);
    expect(disputes.findOneBy).not.toHaveBeenCalled();
    expect(holdLive).toHaveBeenCalledTimes(1);
    expect(answers.get('plain')).toEqual({
      refundable: true,
      until: at(1800 - 60),
      reported: false,
    });
    expect(answers.get('decided')).toEqual({ refundable: false, until: null, reported: true });
    expect(answers.get('open')).toEqual({ refundable: true, until: at(1800 - 60), reported: true });
    expect(answers.get('released')).toEqual({ refundable: false, until: null, reported: false });
  });

  it('reads no dispute when nothing on the page passes', async () => {
    const { service, disputes } = build();
    await service.ofCalls([{ intent: call({ holdReleasedAt: at(-1) }), settledAt: at(-600) }], NOW);
    expect(disputes.find).not.toHaveBeenCalled();
  });
});
