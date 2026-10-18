import { DisputeEntity } from '@database/postgres/entities/dispute.entity';
import { CALL_DISPUTE_SLA } from '@modules/dispute/constants/call-dispute-sla.constants';
import { disputeFilingClosesAt } from '@modules/dispute/domain/call-dispute';
import { slaTimesOf, toDto } from '@modules/dispute/services/call-dispute.service';
import { CALL_DISPUTE_SLA as SWEEP_SLA } from '@modules/dispute/services/call-dispute-sla.service';

const FILED = new Date('2026-10-01T00:00:00Z');
const SETTLED = '2026-09-30T12:00:00.000Z';
const H = 3_600_000;
const CONTEXT = {
  filingWindowMs: 7 * 24 * H,
  twoPersonThresholdUnits: '5',
  holdEndsAt: new Date('2026-10-08T00:00:00Z'),
};

function dispute(overrides: Partial<DisputeEntity> = {}): DisputeEntity {
  return Object.assign(new DisputeEntity(), {
    id: 'd1',
    state: 'OPEN',
    claimType: 'WRONG_DATA',
    reason: '',
    intentId: 'i1',
    respondentProviderId: 'p1',
    providerResponse: null,
    refundGuaranteed: true,
    refundState: null,
    refundAmount: null,
    restoredAmount: null,
    assetId: 'solana:x/token:y',
    decimals: 6,
    evidenceSnapshot: {
      call: { amount: '1000', createdAt: FILED.toISOString() },
      verdict: { settledAt: SETTLED },
    },
    createdAt: FILED,
    updatedAt: FILED,
    ...overrides,
  });
}

describe('call dispute views: the SLA instants (G3.B1)', () => {
  it('are the sweep’s own constants, from the filing', () => {
    expect(SWEEP_SLA).toBe(CALL_DISPUTE_SLA);
    expect(slaTimesOf(dispute(), CONTEXT)).toEqual({
      replyDueAt: new Date(FILED.getTime() + 24 * H),
      pageAt: new Date(FILED.getTime() + 48 * H),
      decisionDueAt: new Date(FILED.getTime() + 72 * H),
      autoUpholdAt: new Date(FILED.getTime() + 72 * H),
      holdEndsAt: CONTEXT.holdEndsAt,
      filingClosesAt: new Date(new Date(SETTLED).getTime() + 7 * 24 * H),
    });
  });

  it('autoUpholdAt only where the SLA may auto-uphold', () => {
    for (const overrides of [
      { providerResponse: 'it was right' },
      { refundGuaranteed: false },
      { state: 'REJECTED' },
      { refundState: 'REFUNDED' },
      // 5 USDC at 6 decimals: two operators decide.
      { evidenceSnapshot: { call: { amount: '5000000' } } },
    ] as Partial<DisputeEntity>[]) {
      expect(slaTimesOf(dispute(overrides), CONTEXT).autoUpholdAt).toBeNull();
    }
  });

  it('holdEndsAt while the hold still matters; filingClosesAt falls back to the call', () => {
    expect(slaTimesOf(dispute({ state: 'REJECTED' }), CONTEXT).holdEndsAt).toBeNull();
    expect(
      slaTimesOf(dispute({ state: 'UPHELD', refundState: 'PENDING' }), CONTEXT).holdEndsAt,
    ).toEqual(CONTEXT.holdEndsAt);
    expect(
      slaTimesOf(
        dispute({ evidenceSnapshot: { call: { createdAt: FILED.toISOString() } } }),
        CONTEXT,
      ).filingClosesAt,
    ).toEqual(new Date(FILED.getTime() + 7 * 24 * H));
    expect(slaTimesOf(dispute({ evidenceSnapshot: null }), CONTEXT).filingClosesAt).toBeNull();
  });

  it('every view carries them', () => {
    expect(toDto(dispute(), CONTEXT)).toMatchObject({
      replyDueAt: expect.any(Date),
      pageAt: expect.any(Date),
      decisionDueAt: expect.any(Date),
      autoUpholdAt: expect.any(Date),
      holdEndsAt: CONTEXT.holdEndsAt,
      filingClosesAt: expect.any(Date),
    });
  });
});

describe('the receipt’s disputeFilingClosesAt', () => {
  const call = {
    organizationId: 'buyer',
    status: 'SETTLED',
    callClass: 'PAID',
    priceAmount: '1000',
    providerId: 'provider',
    updatedAt: FILED,
  };

  it('settlement + the window, for a call that can be disputed', () => {
    expect(disputeFilingClosesAt(call, new Date(SETTLED), 7 * 24 * H)).toEqual(
      new Date(new Date(SETTLED).getTime() + 7 * 24 * H),
    );
    expect(disputeFilingClosesAt(call, null, H)).toEqual(new Date(FILED.getTime() + H));
  });

  it('null where filing is refused anyway', () => {
    for (const overrides of [
      { status: 'VOIDED' },
      { callClass: 'FREE' },
      { priceAmount: '0' },
      { providerId: null },
      { providerId: 'buyer' },
    ]) {
      expect(disputeFilingClosesAt({ ...call, ...overrides }, null, H)).toBeNull();
    }
  });
});
