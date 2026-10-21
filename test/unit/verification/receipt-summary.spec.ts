import {
  PaymentIntentRepository,
  ReceiptsSummaryGroupBy,
  ReceiptsSummaryRow,
} from '@database/postgres/repositories/payment-intent.repository';
import {
  FreeCallsSummaryRow,
  ToolCallRecordRepository,
} from '@database/postgres/repositories/tool-call-record.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { VerificationErrorCode } from '@modules/verification/errors/verification.errors';
import { ReceiptSummaryService } from '@modules/verification/services/receipt-summary.service';
import { SummaryCompareTo } from '@modules/verification/dto/get-receipts-summary.dto';

const ORG = 'org-11111111-1111-4111-8111-111111111111';
const USDC = ASSET_IDS.USDC_SOLANA_MAINNET;

function row(overrides: Partial<ReceiptsSummaryRow>): ReceiptsSummaryRow {
  return {
    key: 'tool-1',
    asset: USDC,
    decimals: 6,
    calls: 0,
    listedTotal: 0n,
    chargedTotal: 0n,
    withheldTotal: 0n,
    refundedCalls: 0,
    notChargedTotal: 0n,
    notChargedCalls: 0,
    owedTotal: 0n,
    owedCalls: 0,
    inProgressTotal: 0n,
    inProgressCalls: 0,
    freeCalls: 0,
    ...overrides,
  };
}

/** No free calls unless a test gives some. */
function freeRepo(
  current: FreeCallsSummaryRow[] = [],
  previous: FreeCallsSummaryRow[] = [],
): ToolCallRecordRepository {
  return {
    summarizeFreeCalls: jest.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(previous),
  } as unknown as ToolCallRecordRepository;
}

function build(rowsByWindow: {
  current: ReceiptsSummaryRow[];
  previous?: ReceiptsSummaryRow[];
  free?: FreeCallsSummaryRow[];
  previousFree?: FreeCallsSummaryRow[];
}) {
  const summarizeReceipts = jest
    .fn()
    .mockResolvedValueOnce(rowsByWindow.current)
    .mockResolvedValueOnce(rowsByWindow.previous ?? []);

  const intents = { summarizeReceipts } as unknown as PaymentIntentRepository;
  const free = freeRepo(rowsByWindow.free, rowsByWindow.previousFree);
  return { service: new ReceiptSummaryService(intents, free), intents, free };
}

const WINDOW = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-08T00:00:00.000Z' };

describe('ReceiptSummaryService — group totals reconcile exactly to the overall totals', () => {
  it('sums calls, listedTotal, chargedTotal and withheldTotal across a mix of groups', async () => {
    const rows: ReceiptsSummaryRow[] = [
      row({
        key: 'tool-1',
        calls: 100,
        listedTotal: 10_000n,
        chargedTotal: 9_000n,
        withheldTotal: 1_000n,
        refundedCalls: 4,
      }),
      row({
        key: 'tool-2',
        calls: 37,
        listedTotal: 3_701n,
        chargedTotal: 3_701n,
        withheldTotal: 0n,
        refundedCalls: 0,
      }),
      row({
        key: 'tool-3',
        calls: 1,
        listedTotal: 999_999n,
        chargedTotal: 0n,
        withheldTotal: 999_999n,
        refundedCalls: 1,
      }),
    ];
    const { service } = build({ current: rows });

    const summary = await service.getSummary(ORG, {
      ...WINDOW,
      groupBy: ReceiptsSummaryGroupBy.TOOL,
    });

    expect(summary.groups).toHaveLength(3);

    const sumField = (field: 'listedTotal' | 'chargedTotal' | 'withheldTotal') =>
      summary.groups.reduce((total, group) => total + BigInt(group[field].amount), 0n);

    expect(sumField('listedTotal')).toBe(BigInt(summary.totals.listedTotal.amount));
    expect(sumField('chargedTotal')).toBe(BigInt(summary.totals.chargedTotal.amount));
    expect(sumField('withheldTotal')).toBe(BigInt(summary.totals.withheldTotal.amount));

    const sumCalls = summary.groups.reduce((total, group) => total + group.calls, 0);
    expect(sumCalls).toBe(summary.totals.calls);
    expect(summary.totals.calls).toBe(138);
    expect(summary.totals.listedTotal.amount).toBe('1013700');
    expect(summary.totals.chargedTotal.amount).toBe('12701');
    expect(summary.totals.withheldTotal.amount).toBe('1000999');
  });

  it('reconciles exactly even with a single group and a zero-call group', async () => {
    const rows: ReceiptsSummaryRow[] = [
      row({
        key: 'REFUNDED',
        calls: 5,
        listedTotal: 500n,
        chargedTotal: 0n,
        withheldTotal: 500n,
        refundedCalls: 5,
      }),
    ];
    const { service } = build({ current: rows });

    const summary = await service.getSummary(ORG, {
      ...WINDOW,
      groupBy: ReceiptsSummaryGroupBy.STATUS,
    });

    expect(summary.totals.calls).toBe(5);
    expect(summary.totals.listedTotal.amount).toBe('500');
    expect(summary.totals.withheldTotal.amount).toBe('500');
    expect(summary.groups[0].failRate).toBe(1);
  });

  it('is exactly zero-reconciled for an empty window', async () => {
    const { service } = build({ current: [] });

    const summary = await service.getSummary(ORG, {
      ...WINDOW,
      groupBy: ReceiptsSummaryGroupBy.DAY,
    });

    expect(summary.groups).toEqual([]);
    expect(summary.totals).toEqual({
      calls: 0,
      refundedCalls: 0,
      listedTotal: { amount: '0', asset: '', decimals: 0 },
      chargedTotal: { amount: '0', asset: '', decimals: 0 },
      withheldTotal: { amount: '0', asset: '', decimals: 0 },
      notChargedTotal: { amount: '0', asset: '', decimals: 0 },
      notChargedCalls: 0,
      owedTotal: { amount: '0', asset: '', decimals: 0 },
      owedCalls: 0,
      inProgressTotal: { amount: '0', asset: '', decimals: 0 },
      inProgressCalls: 0,
      freeCalls: 0,
      failRate: null,
    });
  });

  it('counts free calls per call, so the total is the same whatever the grouping (B1 I2)', async () => {
    // A tool that served free AND paid calls: its group is not "free only",
    // yet its free calls still reach the total.
    const { service } = build({
      current: [
        row({ key: 'tool-1', calls: 10, listedTotal: 800n, chargedTotal: 800n, freeCalls: 2 }),
        row({ key: 'tool-2', calls: 3, freeCalls: 3 }),
      ],
    });

    const summary = await service.getSummary(ORG, {
      ...WINDOW,
      groupBy: ReceiptsSummaryGroupBy.TOOL,
    });

    expect(summary.groups.map((group) => group.freeCalls)).toEqual([2, 3]);
    expect(summary.totals.freeCalls).toBe(5);
  });

  it('counts free-tier calls, which have no intent, in freeCalls only (BUG-AGT-01)', async () => {
    const { service, free } = build({
      current: [row({ key: 'tool-1', calls: 17, listedTotal: 170n, chargedTotal: 170n })],
      free: [
        { key: 'tool-1', freeCalls: 1 },
        { key: 'tool-0', freeCalls: 7 },
      ],
    });

    const summary = await service.getSummary(ORG, {
      ...WINDOW,
      groupBy: ReceiptsSummaryGroupBy.TOOL,
    });

    expect(free.summarizeFreeCalls).toHaveBeenCalledWith(ORG, ReceiptsSummaryGroupBy.TOOL, {
      from: new Date(WINDOW.from),
      to: new Date(WINDOW.to),
    });
    // A key with free calls only is its own group, in key order, money zero.
    expect(summary.groups.map((g) => [g.key, g.calls, g.freeCalls])).toEqual([
      ['tool-0', 0, 7],
      ['tool-1', 17, 1],
    ]);
    expect(summary.groups[0]).toMatchObject({
      listedTotal: { amount: '0', asset: USDC, decimals: 6 },
      notChargedCalls: 0,
      failRate: null,
    });
    // Paid figures are untouched: calls and the money are the paid calls'.
    expect(summary.totals).toMatchObject({
      calls: 17,
      freeCalls: 8,
      listedTotal: { amount: '170' },
      chargedTotal: { amount: '170' },
      notChargedCalls: 0,
    });
  });

  it('counts free calls in the previous window too, for the comparison', async () => {
    const { service } = build({
      current: [],
      previous: [],
      free: [{ key: 'tool-0', freeCalls: 2 }],
      previousFree: [{ key: 'tool-0', freeCalls: 5 }],
    });

    const summary = await service.getSummary(ORG, {
      ...WINDOW,
      groupBy: ReceiptsSummaryGroupBy.TOOL,
      compareTo: SummaryCompareTo.PREVIOUS_PERIOD,
    });

    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0].freeCalls).toBe(2);
    expect(summary.groups[0].comparison?.freeCalls).toBe(5);
    expect(summary.totals.freeCalls).toBe(2);
  });

  it('carries not charged and owed so listed = charged + not charged + owed (R17b-B-01)', async () => {
    // The R17b seed's tool: 7 charged, 1 open debt, 3 withheld, 1 forfeited,
    // 1 voided debt.
    const rows: ReceiptsSummaryRow[] = [
      row({
        key: 'tool-1',
        calls: 13,
        listedTotal: 3_000_000n,
        chargedTotal: 1_500_000n,
        withheldTotal: 750_000n,
        notChargedTotal: 1_250_000n,
        notChargedCalls: 5,
        owedTotal: 250_000n,
        owedCalls: 1,
      }),
      row({
        key: 'tool-2',
        calls: 3,
        listedTotal: 300_000n,
        chargedTotal: 100_000n,
        notChargedTotal: 100_000n,
        notChargedCalls: 1,
        inProgressTotal: 100_000n,
        inProgressCalls: 1,
      }),
    ];
    const { service } = build({ current: rows });

    const summary = await service.getSummary(ORG, {
      ...WINDOW,
      groupBy: ReceiptsSummaryGroupBy.TOOL,
    });

    for (const figures of [...summary.groups, summary.totals]) {
      expect(
        BigInt(figures.chargedTotal.amount) +
          BigInt(figures.notChargedTotal.amount) +
          BigInt(figures.owedTotal.amount) +
          BigInt(figures.inProgressTotal.amount),
      ).toBe(BigInt(figures.listedTotal.amount));
    }
    expect(summary.totals.notChargedTotal.amount).toBe('1350000');
    expect(summary.totals.notChargedCalls).toBe(6);
    expect(summary.totals.owedTotal.amount).toBe('250000');
    expect(summary.totals.owedCalls).toBe(1);
    expect(summary.totals.inProgressCalls).toBe(1);
  });
});

describe('ReceiptSummaryService — failRate', () => {
  it('is null when a group has zero calls, never a divide-by-zero 0', async () => {
    const { service } = build({ current: [row({ calls: 0, refundedCalls: 0 })] });

    const summary = await service.getSummary(ORG, {
      ...WINDOW,
      groupBy: ReceiptsSummaryGroupBy.TOOL,
    });

    expect(summary.groups[0].failRate).toBeNull();
  });

  it('is refundedCalls / calls', async () => {
    const { service } = build({ current: [row({ calls: 20, refundedCalls: 5 })] });

    const summary = await service.getSummary(ORG, {
      ...WINDOW,
      groupBy: ReceiptsSummaryGroupBy.TOOL,
    });

    expect(summary.groups[0].failRate).toBe(0.25);
  });
});

describe('ReceiptSummaryService — compareTo=previous_period', () => {
  it('queries the immediately preceding window of the same length', async () => {
    const { service, intents } = build({ current: [], previous: [] });

    await service.getSummary(ORG, {
      ...WINDOW,
      groupBy: ReceiptsSummaryGroupBy.TOOL,
      compareTo: SummaryCompareTo.PREVIOUS_PERIOD,
    });

    const summarizeReceipts = intents.summarizeReceipts as jest.Mock;
    expect(summarizeReceipts).toHaveBeenCalledTimes(2);

    const [, previousCall] = summarizeReceipts.mock.calls as [unknown, unknown, unknown, unknown][];
    const previousWindow = previousCall[2] as { from: Date; to: Date };

    // Same length, ending exactly where the requested window begins.
    expect(previousWindow.to.toISOString()).toBe(WINDOW.from);
    expect(previousWindow.to.getTime() - previousWindow.from.getTime()).toBe(
      new Date(WINDOW.to).getTime() - new Date(WINDOW.from).getTime(),
    );
  });

  it('attaches a comparison to every group, with deltas against the previous window', async () => {
    const current = [
      row({
        key: 'tool-1',
        calls: 120,
        listedTotal: 12_000n,
        chargedTotal: 11_000n,
        withheldTotal: 1_000n,
      }),
    ];
    const previous = [
      row({
        key: 'tool-1',
        calls: 100,
        listedTotal: 10_000n,
        chargedTotal: 9_000n,
        withheldTotal: 1_000n,
      }),
    ];
    const { service } = build({ current, previous });

    const summary = await service.getSummary(ORG, {
      ...WINDOW,
      groupBy: ReceiptsSummaryGroupBy.TOOL,
      compareTo: SummaryCompareTo.PREVIOUS_PERIOD,
    });

    const comparison = summary.groups[0].comparison;
    expect(comparison).not.toBeNull();
    expect(comparison?.calls).toBe(100);
    expect(comparison?.deltaCalls).toBe(20);
    expect(comparison?.deltaListedTotal).toEqual({ amount: '2000', asset: USDC, decimals: 6 });
    expect(comparison?.deltaChargedTotal).toEqual({ amount: '2000', asset: USDC, decimals: 6 });
    expect(comparison?.deltaWithheldTotal).toEqual({ amount: '0', asset: USDC, decimals: 6 });
    expect(comparison?.deltaNotChargedTotal).toEqual({ amount: '0', asset: USDC, decimals: 6 });
    expect(comparison?.deltaOwedTotal).toEqual({ amount: '0', asset: USDC, decimals: 6 });
  });

  it('treats a group with no previous-window match as a comparison against zero', async () => {
    const current = [row({ key: 'new-tool', calls: 10, listedTotal: 1_000n })];
    const { service } = build({ current, previous: [] });

    const summary = await service.getSummary(ORG, {
      ...WINDOW,
      groupBy: ReceiptsSummaryGroupBy.TOOL,
      compareTo: SummaryCompareTo.PREVIOUS_PERIOD,
    });

    expect(summary.groups[0].comparison).toMatchObject({
      calls: 0,
      deltaCalls: 10,
      deltaListedTotal: { amount: '1000' },
    });
  });

  it('omits comparison entirely when compareTo was not requested', async () => {
    const { service } = build({ current: [row({ key: 'tool-1' })] });

    const summary = await service.getSummary(ORG, {
      ...WINDOW,
      groupBy: ReceiptsSummaryGroupBy.TOOL,
    });

    expect(summary.groups[0].comparison).toBeNull();
  });
});

describe('ReceiptSummaryService — asset resolution', () => {
  it('refuses a window spanning more than one asset with no ?asset= filter', async () => {
    const OTHER = ASSET_IDS.USDC_SOLANA_DEVNET;
    const rows: ReceiptsSummaryRow[] = [
      row({ key: 'tool-1', asset: USDC }),
      row({ key: 'tool-2', asset: OTHER }),
    ];
    const { service } = build({ current: rows });

    await expect(
      service.getSummary(ORG, { ...WINDOW, groupBy: ReceiptsSummaryGroupBy.TOOL }),
    ).rejects.toMatchObject({
      errorCode: VerificationErrorCode.VERIFICATION_SUMMARY_MULTIPLE_ASSETS,
      statusCode: 422,
    });
  });

  it('accepts a mixed window when ?asset= disambiguates it', async () => {
    const { service } = build({ current: [row({ key: 'tool-1', asset: USDC })] });

    const summary = await service.getSummary(ORG, {
      ...WINDOW,
      groupBy: ReceiptsSummaryGroupBy.TOOL,
      asset: USDC,
    });

    expect(summary.asset).toBe(USDC);
  });
});

describe('ReceiptSummaryService — invalid range', () => {
  it('refuses from >= to', async () => {
    const { service } = build({ current: [] });

    await expect(
      service.getSummary(ORG, {
        from: WINDOW.to,
        to: WINDOW.from,
        groupBy: ReceiptsSummaryGroupBy.TOOL,
      }),
    ).rejects.toMatchObject({
      errorCode: VerificationErrorCode.VERIFICATION_SUMMARY_INVALID_RANGE,
      statusCode: 400,
    });
  });
});

describe('ReceiptSummaryService — getDailySummaries', () => {
  const DAILY = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-04T00:00:00.000Z' };

  /** The rows a per-day call would get, as the one grouped query returns them. */
  const rows: ReceiptsSummaryRow[] = [
    row({ day: '2026-08-01', key: 'tool-1', calls: 2, listedTotal: 200n, chargedTotal: 200n }),
    row({ day: '2026-08-03', key: 'tool-1', calls: 1, listedTotal: 50n, withheldTotal: 50n }),
    row({ day: '2026-08-01', key: 'tool-2', calls: 1, listedTotal: 70n, chargedTotal: 70n }),
  ];

  it('asks for the whole window once, split by UTC day', async () => {
    const summarizeReceipts = jest.fn().mockResolvedValue(rows);
    const service = new ReceiptSummaryService(
      {
        summarizeReceipts,
      } as unknown as PaymentIntentRepository,
      freeRepo(),
    );

    await service.getDailySummaries(ORG, { ...DAILY, groupBy: ReceiptsSummaryGroupBy.TOOL });

    expect(summarizeReceipts).toHaveBeenCalledTimes(1);
    expect(summarizeReceipts).toHaveBeenCalledWith(
      ORG,
      ReceiptsSummaryGroupBy.TOOL,
      { from: new Date(DAILY.from), to: new Date(DAILY.to) },
      undefined,
      { byUtcDay: true },
    );
  });

  it('answers each day exactly as getSummary answers that day’s rows, empty days included', async () => {
    const summarizeReceipts = jest.fn().mockResolvedValue(rows);
    const service = new ReceiptSummaryService(
      {
        summarizeReceipts,
      } as unknown as PaymentIntentRepository,
      freeRepo(),
    );
    const daily = await service.getDailySummaries(ORG, {
      ...DAILY,
      groupBy: ReceiptsSummaryGroupBy.TOOL,
    });

    expect(daily.days.map((d) => [d.key, d.from, d.to])).toEqual([
      ['2026-08-01', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'],
      ['2026-08-02', '2026-08-02T00:00:00.000Z', '2026-08-03T00:00:00.000Z'],
      ['2026-08-03', '2026-08-03T00:00:00.000Z', '2026-08-04T00:00:00.000Z'],
    ]);
    for (const day of daily.days) {
      const own = rows
        .filter((r) => r.day === day.key)
        .map(({ day: _day, ...r }) => r as ReceiptsSummaryRow);
      const { service: single } = build({ current: own });
      expect(day.summary).toEqual(
        await single.getSummary(ORG, {
          from: day.from,
          to: day.to,
          groupBy: ReceiptsSummaryGroupBy.TOOL,
        }),
      );
    }
    expect(daily.days[1].summary).toMatchObject({ groups: [], asset: '' });
  });

  it('puts each day’s free calls on that day only (BUG-AGT-01)', async () => {
    const summarizeFreeCalls = jest.fn().mockResolvedValue([
      { key: 'tool-1', day: '2026-08-01', freeCalls: 3 },
      { key: 'tool-9', day: '2026-08-02', freeCalls: 4 },
    ]);
    const service = new ReceiptSummaryService(
      {
        summarizeReceipts: jest.fn().mockResolvedValue(rows),
      } as unknown as PaymentIntentRepository,
      { summarizeFreeCalls } as unknown as ToolCallRecordRepository,
    );

    const daily = await service.getDailySummaries(ORG, {
      ...DAILY,
      groupBy: ReceiptsSummaryGroupBy.TOOL,
    });

    expect(summarizeFreeCalls).toHaveBeenCalledWith(
      ORG,
      ReceiptsSummaryGroupBy.TOOL,
      { from: new Date(DAILY.from), to: new Date(DAILY.to) },
      { byUtcDay: true },
    );
    expect(daily.days.map((d) => d.summary.totals.freeCalls)).toEqual([3, 4, 0]);
    expect(daily.days[0].summary.totals.calls).toBe(3);
    expect(daily.days[1].summary.groups).toEqual([
      expect.objectContaining({ key: 'tool-9', calls: 0, freeCalls: 4 }),
    ]);
  });

  it('refuses a day spanning two assets the way a per-day call does', async () => {
    const summarizeReceipts = jest
      .fn()
      .mockResolvedValue([
        row({ day: '2026-08-01', asset: USDC }),
        row({ day: '2026-08-01', asset: ASSET_IDS.USDC_SOLANA_DEVNET }),
      ]);
    const service = new ReceiptSummaryService(
      {
        summarizeReceipts,
      } as unknown as PaymentIntentRepository,
      freeRepo(),
    );

    await expect(
      service.getDailySummaries(ORG, { ...DAILY, groupBy: ReceiptsSummaryGroupBy.TOOL }),
    ).rejects.toMatchObject({
      errorCode: VerificationErrorCode.VERIFICATION_SUMMARY_MULTIPLE_ASSETS,
    });
  });

  it.each([
    ['an edge off midnight', '2026-08-01T00:00:00.000Z', '2026-08-02T12:00:00.000Z'],
    ['an empty window', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'],
    ['a reversed window', '2026-08-02T00:00:00.000Z', '2026-08-01T00:00:00.000Z'],
    ['32 days', '2026-08-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'],
  ])('refuses %s without querying', async (_name, from, to) => {
    const summarizeReceipts = jest.fn();
    const service = new ReceiptSummaryService(
      {
        summarizeReceipts,
      } as unknown as PaymentIntentRepository,
      freeRepo(),
    );

    await expect(
      service.getDailySummaries(ORG, { from, to, groupBy: ReceiptsSummaryGroupBy.TOOL }),
    ).rejects.toMatchObject({
      errorCode: VerificationErrorCode.VERIFICATION_SUMMARY_INVALID_RANGE,
    });
    expect(summarizeReceipts).not.toHaveBeenCalled();
  });

  it('accepts 31 days', async () => {
    const service = new ReceiptSummaryService(
      {
        summarizeReceipts: jest.fn().mockResolvedValue([]),
      } as unknown as PaymentIntentRepository,
      freeRepo(),
    );
    const daily = await service.getDailySummaries(ORG, {
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-09-01T00:00:00.000Z',
      groupBy: ReceiptsSummaryGroupBy.TOOL,
    });
    expect(daily.days).toHaveLength(31);
  });
});
