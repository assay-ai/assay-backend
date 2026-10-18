import {
  DEFAULT_CALL_DISPUTE_CONFIG,
  loadCallDisputeConfig,
} from '@modules/dispute/constants/call-dispute.config';
import {
  disputeWindowEndOf,
  loadCollectionHoldWindowSeconds,
} from '@modules/payment/constants/collection-hold.constants';
import {
  RefundPlanInput,
  RefundPlanKind,
  RefundSource,
  RefundState,
  boundedBody,
  filingLimitFor,
  isFlaggedBuyer,
  needsSecondOperator,
  planRefund,
  refundColumnsFor,
  withinFilingWindow,
} from '@modules/dispute/domain/call-dispute';

const AT = new Date('2026-10-18T10:00:00Z');

function intent(overrides: Partial<RefundPlanInput> = {}): RefundPlanInput {
  return {
    status: 'SETTLED',
    rail: 'RAIL_B_VOUCHER',
    holdId: 'hold-1',
    holdReleasedAt: AT,
    redemptionLastError: null,
    redemptionLapsedAt: null,
    redemptionReplacedAt: null,
    ...overrides,
  };
}

describe('planRefund — where an upheld refund’s money comes from', () => {
  it('a redeemed voucher: the provider was paid — not refundable', () => {
    expect(planRefund(intent())).toBe(RefundPlanKind.COLLECTED);
  });

  it('a payment held for a dispute filed inside the window: refund it from the hold', () => {
    const held = { holdReleasedAt: null, heldStatus: 'HELD' };
    expect(planRefund(intent({ ...held, disputeOutcome: 'OPEN' }))).toBe(
      RefundPlanKind.RELEASE_HELD,
    );
    expect(planRefund(intent({ ...held, disputeOutcome: 'UPHELD' }))).toBe(
      RefundPlanKind.RELEASE_HELD,
    );
    expect(planRefund(intent({ ...held, rail: 'RAIL_A_PER_CALL', disputeOutcome: 'OPEN' }))).toBe(
      RefundPlanKind.RELEASE_HELD,
    );
  });

  it('a held payment no dispute holds is about to be collected: wait', () => {
    expect(planRefund(intent({ holdReleasedAt: null, heldStatus: 'HELD' }))).toBe(
      RefundPlanKind.COLLECTION_IN_PROGRESS,
    );
  });

  it('a held payment the chain collected (its timeout): not refundable', () => {
    expect(planRefund(intent({ heldStatus: 'COLLECTED', disputeOutcome: 'OPEN' }))).toBe(
      RefundPlanKind.COLLECTED,
    );
  });

  it('a voucher still awaiting redemption: wait, never release under an in-flight voucher', () => {
    expect(planRefund(intent({ holdReleasedAt: null }))).toBe(
      RefundPlanKind.COLLECTION_IN_PROGRESS,
    );
  });

  it('an outstanding buyer debt: the provider was never paid — void it', () => {
    expect(planRefund(intent({ holdReleasedAt: null, redemptionLapsedAt: AT }))).toBe(
      RefundPlanKind.VOID_DEBT,
    );
  });

  it('a written-off debt: the buyer still owes it — void it', () => {
    expect(
      planRefund(
        intent({ redemptionLapsedAt: AT, redemptionLastError: 'uncollected:DelegateIsRevoked' }),
      ),
    ).toBe(RefundPlanKind.VOID_DEBT);
  });

  it('a debt whose replacement voucher is in flight: wait', () => {
    expect(
      planRefund(
        intent({ holdReleasedAt: null, redemptionLapsedAt: AT, redemptionReplacedAt: AT }),
      ),
    ).toBe(RefundPlanKind.COLLECTION_IN_PROGRESS);
  });

  it('a debt whose replacement was redeemed: the provider was paid', () => {
    expect(planRefund(intent({ redemptionLapsedAt: AT, redemptionReplacedAt: AT }))).toBe(
      RefundPlanKind.COLLECTED,
    );
  });

  it('forfeited or voided already: the buyer was never charged', () => {
    expect(planRefund(intent({ redemptionLastError: 'provider_forfeit:ProviderBlocked' }))).toBe(
      RefundPlanKind.NOT_CHARGED,
    );
    expect(planRefund(intent({ redemptionLastError: 'voided:REFUND' }))).toBe(
      RefundPlanKind.NOT_CHARGED,
    );
  });

  it('a void written by an upheld dispute is recognised on a retry', () => {
    expect(planRefund(intent({ redemptionLastError: 'voided:DISPUTE_UPHELD' }))).toBe(
      RefundPlanKind.ALREADY_REFUNDED,
    );
  });

  it('a call that never settled, or never held, charged nothing', () => {
    expect(planRefund(intent({ status: 'REFUNDED' }))).toBe(RefundPlanKind.NOT_CHARGED);
    expect(planRefund(intent({ holdId: null }))).toBe(RefundPlanKind.NOT_CHARGED);
  });

  it('rail A: committed inline at settle, so the provider was credited', () => {
    expect(planRefund(intent({ rail: 'RAIL_A_PER_CALL' }))).toBe(RefundPlanKind.COLLECTED);
    expect(planRefund(intent({ rail: 'RAIL_A_PER_CALL', holdReleasedAt: null }))).toBe(
      RefundPlanKind.COLLECTION_IN_PROGRESS,
    );
  });
});

describe('refundColumnsFor', () => {
  it('maps each plan to the columns an upheld decision writes', () => {
    expect(refundColumnsFor(RefundPlanKind.VOID_DEBT)).toEqual({
      source: RefundSource.UNCOLLECTED_EARNINGS,
      state: RefundState.PENDING,
    });
    expect(refundColumnsFor(RefundPlanKind.COLLECTED)).toEqual({
      source: RefundSource.NONE,
      state: RefundState.NOT_REFUNDABLE,
    });
    expect(refundColumnsFor(RefundPlanKind.RELEASE_HELD)).toEqual({
      source: RefundSource.UNCOLLECTED_EARNINGS,
      state: RefundState.PENDING,
    });
    expect(refundColumnsFor(RefundPlanKind.NOT_CHARGED)).toEqual({
      source: RefundSource.NONE,
      state: RefundState.NOT_CHARGED,
    });
    expect(refundColumnsFor(RefundPlanKind.ALREADY_REFUNDED)?.state).toBe(RefundState.REFUNDED);
    expect(refundColumnsFor(RefundPlanKind.COLLECTION_IN_PROGRESS)).toBeNull();
  });
});

describe('filing rules', () => {
  it('opens a window of N days after settlement, inclusive', () => {
    const week = 7 * 24 * 3600 * 1000;
    expect(withinFilingWindow(AT, new Date(AT.getTime() + week), week)).toBe(true);
    expect(withinFilingWindow(AT, new Date(AT.getTime() + week + 1), week)).toBe(false);
  });

  it('flags a buyer only when it has enough rejections and more rejections than upholds', () => {
    expect(isFlaggedBuyer({ upheldLast30Days: 0, rejectedLast30Days: 5 }, 5)).toBe(true);
    expect(isFlaggedBuyer({ upheldLast30Days: 0, rejectedLast30Days: 4 }, 5)).toBe(false);
    expect(isFlaggedBuyer({ upheldLast30Days: 6, rejectedLast30Days: 6 }, 5)).toBe(false);
  });

  it('applies the tighter daily limit to a flagged buyer', () => {
    const config = DEFAULT_CALL_DISPUTE_CONFIG;
    expect(
      filingLimitFor({ filedLastDay: 0, upheldLast30Days: 0, rejectedLast30Days: 0 }, config),
    ).toEqual({ limit: config.maxFilingsPerDay, flagged: false });
    expect(
      filingLimitFor({ filedLastDay: 0, upheldLast30Days: 1, rejectedLast30Days: 9 }, config),
    ).toEqual({ limit: config.abuseMaxFilingsPerDay, flagged: true });
  });

  it('needs a second operator at or above the threshold', () => {
    expect(needsSecondOperator('4999999', '5000000')).toBe(false);
    expect(needsSecondOperator('5000000', '5000000')).toBe(true);
  });
});

describe('boundedBody', () => {
  it('keeps a body that fits, and cuts one that does not', () => {
    expect(boundedBody({ a: 1 }, 100)).toEqual({ a: 1 });
    expect(boundedBody(null, 100)).toBeNull();
    const cut = boundedBody({ text: 'x'.repeat(500) }, 64) as Record<string, unknown>;
    expect(cut.truncated).toBe(true);
    expect((cut.head as string).length).toBe(64);
  });
});

describe('loadCallDisputeConfig', () => {
  it('reads the environment and falls back on a malformed value', () => {
    const config = loadCallDisputeConfig({
      CALL_DISPUTE_FILING_WINDOW_DAYS: '3',
      CALL_DISPUTE_MAX_PER_DAY: 'lots',
      CALL_DISPUTE_TWO_PERSON_THRESHOLD_MINOR: '100',
    });
    expect(config.filingWindowMs).toBe(3 * 24 * 3600 * 1000);
    expect(config.maxFilingsPerDay).toBe(DEFAULT_CALL_DISPUTE_CONFIG.maxFilingsPerDay);
    expect(config.twoPersonThresholdMinor).toBe('100');
    expect(loadCallDisputeConfig({}).twoPersonThresholdMinor).toBe('5000000');
    expect(loadCallDisputeConfig({}).snapshotRetentionMs).toBe(30 * 24 * 3600 * 1000);
  });
});

describe('the dispute hold window', () => {
  it('defaults to an hour, accepts 1 to 1440 minutes, and refuses anything else', () => {
    expect(loadCollectionHoldWindowSeconds({})).toBe(3600);
    expect(loadCollectionHoldWindowSeconds({ CALL_DISPUTE_HOLD_WINDOW_MINUTES: '15' })).toBe(900);
    for (const bad of ['0', '1441', 'an hour']) {
      expect(() =>
        loadCollectionHoldWindowSeconds({ CALL_DISPUTE_HOLD_WINDOW_MINUTES: bad }),
      ).toThrow(/1 to 1440/);
    }
  });

  it('ends the guaranteed window a guard before collection', () => {
    const at = new Date('2026-10-18T12:00:00Z');
    expect(disputeWindowEndOf(at)?.toISOString()).toBe('2026-10-18T11:59:00.000Z');
    expect(disputeWindowEndOf(null)).toBeNull();
  });
});
