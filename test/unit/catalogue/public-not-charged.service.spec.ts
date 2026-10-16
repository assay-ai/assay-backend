import {
  NotChargedCallRow,
  NotChargedTotalsRow,
  NotChargedWindow,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import { NotChargedReason, notChargedReason } from '@modules/catalogue/domain/not-charged-reason';
import { PublicCatalogueService } from '@modules/catalogue/services/public-catalogue.service';
import {
  NOT_CHARGED_CACHE_MS,
  NOT_CHARGED_MIN_BUYERS,
  NOT_CHARGED_RECENT_LIMIT,
  PublicNotChargedService,
  foldTotals,
  selectKAnonymous,
} from '@modules/catalogue/services/public-not-charged.service';
import { WithheldBucket } from '@modules/ledger/domain/withheld';

const SOLANA_USDC =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EVM_USDC = 'eip155:4663/erc20:0x0000000000000000000000000000000000000001';
const LISTED = 'a6d1f0e2-0000-4000-8000-000000000001';
const UNLISTED = 'b7e2a1f3-0000-4000-8000-000000000002';
const WEATHER = 'tool-weather';
const RATE = 'tool-rate';

const NOW = new Date('2026-10-15T10:00:30.000Z');

let seq = 0;
function row(overrides: Partial<NotChargedCallRow> = {}): NotChargedCallRow {
  seq += 1;
  return {
    toolId: WEATHER,
    providerId: LISTED,
    status: 'REFUNDED',
    classification: 'DATA_RESULT',
    verificationVerdict: 'FAIL',
    asset: SOLANA_USDC,
    decimals: 6,
    priceAmount: 250000n,
    // Newest first, as the repository returns them.
    createdAt: new Date(Date.parse('2026-10-13T23:00:00.000Z') - seq * 60_000),
    settledCause: null,
    buyer: `buyer-${seq}`,
    ...overrides,
  };
}

/** `n` rows of one tool from `n` distinct buyers. */
const fromBuyers = (n: number, overrides: Partial<NotChargedCallRow> = {}) =>
  Array.from({ length: n }, () => row(overrides));

function totalsRow(overrides: Partial<NotChargedTotalsRow> = {}): NotChargedTotalsRow {
  return {
    asset: SOLANA_USDC,
    decimals: 6,
    calls: 10,
    buyers: 6,
    notChargedCalls: 1,
    failedCheckCalls: 1,
    notChargedAmount: 250000n,
    ...overrides,
  };
}

function build(rows: NotChargedCallRow[], totals: NotChargedTotalsRow[] = []) {
  const intents = {
    findNotChargedCandidates: jest.fn(async (_window: NotChargedWindow, _limit: number) => rows),
    summarizeNotCharged: jest.fn(async (_window: NotChargedWindow) => totals),
  };
  const catalogue = {
    listProviders: jest.fn(async () => ({
      providers: [{ providerId: LISTED, name: 'Open-Meteo Demo BV' }],
    })),
    listTools: jest.fn(async () => ({
      tools: [
        { id: WEATHER, name: 'get_weather' },
        { id: RATE, name: 'get_rate' },
      ],
    })),
  };
  const service = new PublicNotChargedService(
    intents as unknown as PaymentIntentRepository,
    catalogue as unknown as PublicCatalogueService,
  );
  return { service, intents, catalogue };
}

describe('PublicNotChargedService', () => {
  /**
   * The safety argument of an unauthenticated route: nothing on the wire
   * identifies a buyer, an organization, an agent, a call or a transaction.
   * Pinned as the EXACT key set, so a field added later is a red test.
   */
  it('publishes exactly the anonymised keys, at every level', async () => {
    const { service } = build(fromBuyers(5), [totalsRow()]);

    const body = await service.read(NOW);

    expect(Object.keys(body).sort()).toEqual([
      'minBuyers',
      'recent',
      'since',
      'totals',
      'until',
      'windowDays',
      'withheldForPrivacy',
    ]);
    expect(Object.keys(body.totals).sort()).toEqual([
      'amountNotCharged',
      'callsChecked',
      'callsFailedCheck',
      'callsNotCharged',
    ]);
    expect(Object.keys(body.totals.amountNotCharged[0]).sort()).toEqual([
      'amount',
      'asset',
      'decimals',
    ]);
    expect(body.recent).toHaveLength(5);
    for (const call of body.recent) {
      expect(Object.keys(call).sort()).toEqual([
        'bucket',
        'day',
        'price',
        'providerName',
        'reason',
        'reasonText',
        'toolId',
        'toolName',
      ]);
      expect(Object.keys(call.price).sort()).toEqual(['amount', 'asset', 'decimals']);
    }
    // No provider id, and no buyer digest, hides in a value either.
    const wire = JSON.stringify(body);
    expect(wire).not.toContain(LISTED);
    expect(wire).not.toContain('buyer-');
  });

  it('names tool and provider, prices in atomic units, and dates to the UTC day', async () => {
    const { service } = build(fromBuyers(5));

    const [call] = (await service.read(NOW)).recent;

    expect(call).toEqual({
      toolId: WEATHER,
      toolName: 'get_weather',
      providerName: 'Open-Meteo Demo BV',
      price: { amount: '250000', asset: SOLANA_USDC, decimals: 6 },
      reason: NotChargedReason.FAILED_CHECK,
      reasonText: expect.any(String),
      bucket: WithheldBucket.FAILED_VERIFICATION,
      day: '2026-10-13',
    });
  });

  it('reads rows at least 24 h old, totals over complete UTC days, buyers at least 7 days old', async () => {
    const { service, intents } = build([]);

    const body = await service.read(NOW);

    const buyerCreatedBefore = new Date('2026-10-08T10:00:30.000Z');
    expect(intents.findNotChargedCandidates).toHaveBeenCalledWith(
      {
        from: new Date('2026-09-15T00:00:00.000Z'),
        to: new Date('2026-10-14T10:00:30.000Z'),
        buyerCreatedBefore,
      },
      expect.any(Number),
    );
    expect(intents.summarizeNotCharged).toHaveBeenCalledWith({
      from: new Date('2026-09-15T00:00:00.000Z'),
      to: new Date('2026-10-15T00:00:00.000Z'),
      buyerCreatedBefore,
    });
    expect(body).toMatchObject({
      windowDays: 30,
      since: '2026-09-15T00:00:00.000Z',
      until: '2026-10-15T00:00:00.000Z',
    });
  });

  /** M2: a provider that is not on the public list is never named. */
  it('drops rows whose provider is not publicly listed, or not named at all', async () => {
    const { service } = build([
      ...fromBuyers(5),
      ...fromBuyers(5, { providerId: UNLISTED }),
      ...fromBuyers(5, { providerId: null }),
    ]);

    const body = await service.read(NOW);

    expect(body.recent).toHaveLength(5);
    expect(body.recent.every((call) => call.providerName === 'Open-Meteo Demo BV')).toBe(true);
  });

  it('publishes at most 20 rows', async () => {
    const { service } = build(fromBuyers(40));

    expect((await service.read(NOW)).recent).toHaveLength(NOT_CHARGED_RECENT_LIMIT);
  });

  describe('cache', () => {
    it('reuses one answer inside the window and reloads after it', async () => {
      const { service, intents } = build(fromBuyers(5));

      await service.read(NOW);
      await service.read(new Date(NOW.getTime() + NOT_CHARGED_CACHE_MS - 1));
      expect(intents.findNotChargedCandidates).toHaveBeenCalledTimes(1);

      await service.read(new Date(NOW.getTime() + NOT_CHARGED_CACHE_MS));
      expect(intents.findNotChargedCandidates).toHaveBeenCalledTimes(2);
    });

    it('shares the load in flight between concurrent requests', async () => {
      const { service, intents } = build(fromBuyers(5));

      await Promise.all([service.read(NOW), service.read(NOW), service.read(NOW)]);

      expect(intents.findNotChargedCandidates).toHaveBeenCalledTimes(1);
    });

    it('does not cache a failure', async () => {
      const { service, intents } = build(fromBuyers(5));
      intents.findNotChargedCandidates.mockRejectedValueOnce(new Error('db down'));

      await expect(service.read(NOW)).rejects.toThrow('db down');
      await expect(service.read(NOW)).resolves.toMatchObject({ windowDays: 30 });
    });
  });
});

/**
 * k-anonymity, k = 5, applied to the rows ACTUALLY PUBLISHED: a tool backed by
 * five buyers somewhere in 30 days, but by one buyer among the rows shown,
 * would still expose that one buyer.
 */
describe('the k-anonymity rule', () => {
  it('is five buyers', () => {
    expect(NOT_CHARGED_MIN_BUYERS).toBe(5);
  });

  it('publishes a tool backed by k buyers and withholds one backed by k − 1', async () => {
    const { service } = build([
      ...fromBuyers(NOT_CHARGED_MIN_BUYERS),
      ...fromBuyers(NOT_CHARGED_MIN_BUYERS - 1, { toolId: RATE }),
    ]);

    const body = await service.read(NOW);

    expect(new Set(body.recent.map((call) => call.toolId))).toEqual(new Set([WEATHER]));
    expect(body.withheldForPrivacy).toBe(true);
    expect(body.minBuyers).toBe(5);
  });

  it('counts distinct buyers, not rows', async () => {
    const one = fromBuyers(10).map((r) => ({ ...r, buyer: 'same-buyer' }));
    const { service } = build(one);

    const body = await service.read(NOW);

    expect(body.recent).toEqual([]);
    expect(body.withheldForPrivacy).toBe(true);
  });

  it('counts on the published selection, not on older rows cut from it', () => {
    // 20 newest rows of the tool all come from ONE buyer; four other buyers
    // appear only further back. Over the whole window the tool has 5 buyers,
    // but the 20 rows that would be published name one — so none are.
    const newest = Array.from({ length: 20 }, () => row({ buyer: 'heavy' }));
    const older = Array.from({ length: 4 }, () => row());

    const { published, suppressed } = selectKAnonymous([...newest, ...older], 20, 5);

    expect(published).toEqual([]);
    expect(suppressed).toBe(true);
  });

  it('refills the selection from the remaining tools after a ban', () => {
    const rare = Array.from({ length: 3 }, () => row({ toolId: RATE }));
    const common = fromBuyers(25);

    const { published } = selectKAnonymous([...rare, ...common], 20, 5);

    expect(published).toHaveLength(20);
    expect(published.every((r) => r.toolId === WEATHER)).toBe(true);
    expect(new Set(published.map((r) => r.buyer)).size).toBeGreaterThanOrEqual(5);
  });

  it('leaves an asset with fewer than k eligible buyers out of every total', async () => {
    const quiet = totalsRow({ asset: EVM_USDC, calls: 3, buyers: 4, notChargedAmount: 500000n });
    const busy = totalsRow({
      calls: 50,
      buyers: 12,
      notChargedCalls: 4,
      failedCheckCalls: 1,
      notChargedAmount: 1000000n,
    });
    const { service } = build([], [quiet, busy]);

    const body = await service.read(NOW);

    expect(body.totals).toEqual({
      callsChecked: 50,
      callsNotCharged: 4,
      callsFailedCheck: 1,
      amountNotCharged: [{ amount: '1000000', asset: SOLANA_USDC, decimals: 6 }],
    });
    expect(body.withheldForPrivacy).toBe(true);
  });

  it('withholds nothing, and says so, when every figure clears the floor', async () => {
    const { service } = build(fromBuyers(8), [totalsRow()]);

    expect((await service.read(NOW)).withheldForPrivacy).toBe(false);
  });
});

describe('foldTotals — the 30-day figures', () => {
  it('adds call counts across assets and keeps amounts one entry per asset', () => {
    const totals = foldTotals([
      totalsRow({
        asset: EVM_USDC,
        calls: 40,
        notChargedCalls: 5,
        failedCheckCalls: 3,
        notChargedAmount: 1_250_000n,
      }),
      totalsRow({
        calls: 60,
        notChargedCalls: 7,
        failedCheckCalls: 2,
        notChargedAmount: 9_007_199_254_740_993n,
      }),
    ]);

    expect(totals).toEqual({
      callsChecked: 100,
      callsNotCharged: 12,
      callsFailedCheck: 5,
      amountNotCharged: [
        { amount: '1250000', asset: EVM_USDC, decimals: 6 },
        // Beyond 2^53: atomic units stay exact strings.
        { amount: '9007199254740993', asset: SOLANA_USDC, decimals: 6 },
      ],
    });
  });

  it('is all zeros and no amounts on a quiet deployment', () => {
    expect(foldTotals([])).toEqual({
      callsChecked: 0,
      callsNotCharged: 0,
      callsFailedCheck: 0,
      amountNotCharged: [],
    });
  });
});

describe('notChargedReason', () => {
  it.each([
    [
      'REFUNDED',
      'DATA_RESULT',
      'FAIL',
      NotChargedReason.FAILED_CHECK,
      WithheldBucket.FAILED_VERIFICATION,
    ],
    [
      'VOIDED',
      'DATA_RESULT',
      'MISAPPLIED',
      NotChargedReason.OUT_OF_SCOPE,
      WithheldBucket.PROVIDER_OR_PLATFORM_ERROR,
    ],
    [
      'VOIDED',
      'SYSTEM_ERROR',
      null,
      NotChargedReason.PROVIDER_ERROR,
      WithheldBucket.PROVIDER_OR_PLATFORM_ERROR,
    ],
    [
      'VOIDED',
      'REQUEST_ERROR',
      null,
      NotChargedReason.REQUEST_REJECTED,
      WithheldBucket.PROVIDER_OR_PLATFORM_ERROR,
    ],
    [
      'VOIDED',
      null,
      null,
      NotChargedReason.NO_USABLE_RESULT,
      WithheldBucket.PROVIDER_OR_PLATFORM_ERROR,
    ],
    ['EXPIRED', null, null, NotChargedReason.EXPIRED, WithheldBucket.PROVIDER_OR_PLATFORM_ERROR],
  ])('%s / %s / %s → %s', (status, classification, verificationVerdict, reason, bucket) => {
    expect(notChargedReason({ status, classification, verificationVerdict })).toEqual({
      reason,
      bucket,
    });
  });

  it('has no reason for a charged call', () => {
    expect(
      notChargedReason({
        status: 'SETTLED',
        classification: 'DATA_RESULT',
        verificationVerdict: 'PASS',
      }),
    ).toBeNull();
  });
  it('has no reason for an owed call: open or written-off buyer debt carries no cause', () => {
    // The repository derives `settledCause` as NULL for an open debt and for a
    // written-off one (`uncollected:`), so neither can be published as "not charged".
    expect(
      notChargedReason({
        status: 'SETTLED',
        classification: 'DATA_RESULT',
        verificationVerdict: null,
        settledCause: null,
      }),
    ).toBeNull();
  });

  it.each([
    [
      'VOIDED_REFUND',
      'DATA_RESULT',
      'FAIL',
      NotChargedReason.FAILED_CHECK,
      WithheldBucket.FAILED_VERIFICATION,
    ],
    [
      'VOIDED_VOID',
      'DATA_RESULT',
      'MISAPPLIED',
      NotChargedReason.OUT_OF_SCOPE,
      WithheldBucket.PROVIDER_OR_PLATFORM_ERROR,
    ],
    [
      'VOIDED_VOID',
      'SYSTEM_ERROR',
      null,
      NotChargedReason.PROVIDER_ERROR,
      WithheldBucket.PROVIDER_OR_PLATFORM_ERROR,
    ],
    [
      'FORFEITED',
      'DATA_RESULT',
      'PASS',
      NotChargedReason.NOT_COLLECTED,
      WithheldBucket.PROVIDER_OR_PLATFORM_ERROR,
    ],
    [
      'ABSORBED',
      'DATA_RESULT',
      'PASS',
      NotChargedReason.NOT_COLLECTED,
      WithheldBucket.PROVIDER_OR_PLATFORM_ERROR,
    ],
  ] as const)(
    'SETTLED with cause %s / %s / %s → %s',
    (settledCause, classification, verificationVerdict, reason, bucket) => {
      expect(
        notChargedReason({ status: 'SETTLED', classification, verificationVerdict, settledCause }),
      ).toEqual({ reason, bucket });
    },
  );
});
