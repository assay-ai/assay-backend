import { ProviderEntity } from '@database/postgres/entities/provider.entity';
import {
  NotChargedCallRow,
  NotChargedToolBuyersRow,
  NotChargedTotalsRow,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { NotChargedReason, notChargedReason } from '@modules/catalogue/domain/not-charged-reason';
import {
  NOT_CHARGED_CACHE_MS,
  NOT_CHARGED_MIN_BUYERS,
  NOT_CHARGED_RECENT_LIMIT,
  PublicNotChargedService,
  foldTotals,
} from '@modules/catalogue/services/public-not-charged.service';
import { WithheldBucket } from '@modules/ledger/domain/withheld';
import { ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { Tool, ToolTier } from '@modules/tool/ports/tool.types';

const SOLANA_USDC =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EVM_USDC = 'eip155:4663/erc20:0x0000000000000000000000000000000000000001';
const PROVIDER = 'a6d1f0e2-0000-4000-8000-000000000001';

const WEATHER: Tool = {
  id: 'tool-weather',
  name: 'get_weather',
  description: 'Weather',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  verificationPolicyId: 'policy',
  tier: ToolTier.VERIFIED,
};

function row(overrides: Partial<NotChargedCallRow> = {}): NotChargedCallRow {
  return {
    toolId: WEATHER.id,
    providerId: PROVIDER,
    status: 'REFUNDED',
    classification: 'DATA_RESULT',
    verificationVerdict: 'FAIL',
    asset: SOLANA_USDC,
    decimals: 6,
    priceAmount: 250000n,
    createdAt: new Date('2026-10-15T09:41:37.512Z'),
    ...overrides,
  };
}

function build(
  rows: NotChargedCallRow[],
  totals: NotChargedTotalsRow[] = [],
  buyersByTool: NotChargedToolBuyersRow[] = [{ toolId: WEATHER.id, buyers: 5 }],
) {
  const intents = {
    countNotChargedBuyersByTool: jest.fn(async () => buyersByTool),
    // Honours the tool filter the way the SQL does.
    findRecentNotCharged: jest.fn(
      async (_since: Date, _limit: number, toolIds: readonly string[]) =>
        rows.filter((row) => toolIds.includes(row.toolId)),
    ),
    summarizeNotCharged: jest.fn(async () => totals),
  };
  const providers = {
    findOne: jest.fn(async ({ where }: { where: { organizationId: string } }) =>
      where.organizationId === PROVIDER
        ? ({ organizationId: PROVIDER, legalName: 'Open-Meteo Demo BV' } as ProviderEntity)
        : null,
    ),
  };
  const catalogue: ToolCataloguePort = {
    findTool: jest.fn(),
    listTools: jest.fn(async () => [WEATHER]),
    findBindings: jest.fn(),
  };
  const service = new PublicNotChargedService(
    intents as unknown as PaymentIntentRepository,
    providers as unknown as ProviderRepository,
    catalogue,
  );
  return { service, intents, providers };
}

const NOW = new Date('2026-10-15T10:00:30.000Z');

describe('PublicNotChargedService', () => {
  /**
   * The whole safety argument of an unauthenticated route: nothing on the wire
   * identifies a buyer, an organization, an agent, a call or a transaction.
   * Pinned as the EXACT key set, so a field added later is a red test and a
   * conversation rather than a leak.
   */
  it('publishes exactly the anonymised keys, at every level', async () => {
    const { service } = build(
      [row()],
      [
        {
          asset: SOLANA_USDC,
          decimals: 6,
          calls: 10,
          buyers: 6,
          notChargedCalls: 1,
          failedCheckCalls: 1,
          notChargedAmount: 250000n,
        },
      ],
    );

    const body = await service.read(NOW);

    expect(Object.keys(body).sort()).toEqual([
      'minBuyers',
      'recent',
      'since',
      'totals',
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
    expect(body.recent).toHaveLength(1);
    expect(Object.keys(body.recent[0]).sort()).toEqual([
      'at',
      'bucket',
      'price',
      'providerName',
      'reason',
      'reasonText',
      'toolId',
      'toolName',
    ]);
    expect(Object.keys(body.recent[0].price).sort()).toEqual(['amount', 'asset', 'decimals']);
    // And no provider/organization id hides in a value either.
    expect(JSON.stringify(body)).not.toContain(PROVIDER);
  });

  it('names the tool and provider, prices in atomic units, and truncates the time to the minute', async () => {
    const { service } = build([row()]);

    const [call] = (await service.read(NOW)).recent;

    expect(call).toEqual({
      toolId: WEATHER.id,
      toolName: 'get_weather',
      providerName: 'Open-Meteo Demo BV',
      price: { amount: '250000', asset: SOLANA_USDC, decimals: 6 },
      reason: NotChargedReason.FAILED_CHECK,
      reasonText: expect.any(String),
      bucket: WithheldBucket.FAILED_VERIFICATION,
      at: '2026-10-15T09:41:00.000Z',
    });
  });

  it('falls back to the tool id and a null provider name rather than guessing', async () => {
    const { service } = build(
      [row({ toolId: 'tool-gone', providerId: null })],
      [],
      [{ toolId: 'tool-gone', buyers: 5 }],
    );

    const [call] = (await service.read(NOW)).recent;

    expect(call.toolName).toBe('tool-gone');
    expect(call.providerName).toBeNull();
  });

  it('asks for the 20 most recent over a 30-day window that starts on a minute', async () => {
    const { service, intents } = build([]);

    const body = await service.read(NOW);

    expect(intents.findRecentNotCharged).toHaveBeenCalledWith(
      new Date('2026-09-15T10:00:00.000Z'),
      NOT_CHARGED_RECENT_LIMIT,
      [WEATHER.id],
    );
    expect(body.windowDays).toBe(30);
    expect(body.since).toBe('2026-09-15T10:00:00.000Z');
    expect(NOT_CHARGED_RECENT_LIMIT).toBe(20);
  });

  it('looks each provider up once, however many rows name it', async () => {
    const { service, providers } = build([row(), row(), row()]);

    await service.read(NOW);

    expect(providers.findOne).toHaveBeenCalledTimes(1);
  });

  describe('cache', () => {
    it('reuses one answer inside the window and reloads after it', async () => {
      const { service, intents } = build([row()]);

      await service.read(NOW);
      await service.read(new Date(NOW.getTime() + NOT_CHARGED_CACHE_MS - 1));
      expect(intents.findRecentNotCharged).toHaveBeenCalledTimes(1);

      await service.read(new Date(NOW.getTime() + NOT_CHARGED_CACHE_MS));
      expect(intents.findRecentNotCharged).toHaveBeenCalledTimes(2);
    });

    it('shares the load in flight between concurrent requests', async () => {
      const { service, intents } = build([row()]);

      await Promise.all([service.read(NOW), service.read(NOW), service.read(NOW)]);

      expect(intents.findRecentNotCharged).toHaveBeenCalledTimes(1);
    });

    it('does not cache a failure', async () => {
      const { service, intents } = build([row()]);
      intents.findRecentNotCharged.mockRejectedValueOnce(new Error('db down'));

      await expect(service.read(NOW)).rejects.toThrow('db down');
      await expect(service.read(NOW)).resolves.toMatchObject({ windowDays: 30 });
      expect(intents.findRecentNotCharged).toHaveBeenCalledTimes(2);
    });
  });
});

/**
 * k-anonymity, k = 5. A row naming a tool only one buyer uses is that buyer's
 * activity however little else it carries, so below the floor nothing about
 * that tool is listed, and an asset with too few buyers is left out of the
 * totals. Suppression is flagged so a zero is not read as "nothing happened".
 */
describe('PublicNotChargedService — the k-anonymity rule', () => {
  const RARE = 'tool-rare';
  const rows = [row(), row({ toolId: RARE })];

  it('is five buyers', () => {
    expect(NOT_CHARGED_MIN_BUYERS).toBe(5);
  });

  it('lists a tool backed by k buyers and withholds one backed by k − 1', async () => {
    const { service, intents } = build(
      rows,
      [],
      [
        { toolId: WEATHER.id, buyers: NOT_CHARGED_MIN_BUYERS },
        { toolId: RARE, buyers: NOT_CHARGED_MIN_BUYERS - 1 },
      ],
    );

    const body = await service.read(NOW);

    expect(intents.findRecentNotCharged.mock.calls[0][2]).toEqual([WEATHER.id]);
    expect(body.recent.map((call) => call.toolId)).toEqual([WEATHER.id]);
    expect(body.withheldForPrivacy).toBe(true);
    expect(body.minBuyers).toBe(5);
  });

  it('lists nothing, and says so, when every tool is below the floor', async () => {
    const { service } = build(
      rows,
      [],
      [
        { toolId: WEATHER.id, buyers: 1 },
        { toolId: RARE, buyers: 4 },
      ],
    );

    const body = await service.read(NOW);

    expect(body.recent).toEqual([]);
    expect(body.withheldForPrivacy).toBe(true);
  });

  it('leaves an asset with fewer than k buyers out of every total', async () => {
    const quiet: NotChargedTotalsRow = {
      asset: EVM_USDC,
      decimals: 6,
      calls: 3,
      buyers: 1,
      notChargedCalls: 2,
      failedCheckCalls: 2,
      notChargedAmount: 500000n,
    };
    const busy: NotChargedTotalsRow = {
      asset: SOLANA_USDC,
      decimals: 6,
      calls: 50,
      buyers: 12,
      notChargedCalls: 4,
      failedCheckCalls: 1,
      notChargedAmount: 1000000n,
    };
    const { service } = build([], [quiet, busy], []);

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
    const { service } = build([row()], [], [{ toolId: WEATHER.id, buyers: 8 }]);

    expect((await service.read(NOW)).withheldForPrivacy).toBe(false);
  });
});

describe('foldTotals — the 30-day figures', () => {
  it('adds call counts across assets and keeps amounts one entry per asset', () => {
    const totals = foldTotals([
      {
        asset: EVM_USDC,
        decimals: 6,
        calls: 40,
        buyers: 5,
        notChargedCalls: 5,
        failedCheckCalls: 3,
        notChargedAmount: 1_250_000n,
      },
      {
        asset: SOLANA_USDC,
        decimals: 6,
        calls: 60,
        buyers: 9,
        notChargedCalls: 7,
        failedCheckCalls: 2,
        notChargedAmount: 9_007_199_254_740_993n,
      },
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
      { status: 'REFUNDED', classification: 'DATA_RESULT', verificationVerdict: 'FAIL' },
      NotChargedReason.FAILED_CHECK,
      WithheldBucket.FAILED_VERIFICATION,
    ],
    [
      { status: 'VOIDED', classification: 'DATA_RESULT', verificationVerdict: 'MISAPPLIED' },
      NotChargedReason.OUT_OF_SCOPE,
      WithheldBucket.PROVIDER_OR_PLATFORM_ERROR,
    ],
    [
      { status: 'VOIDED', classification: 'SYSTEM_ERROR', verificationVerdict: null },
      NotChargedReason.PROVIDER_ERROR,
      WithheldBucket.PROVIDER_OR_PLATFORM_ERROR,
    ],
    [
      { status: 'VOIDED', classification: 'REQUEST_ERROR', verificationVerdict: null },
      NotChargedReason.REQUEST_REJECTED,
      WithheldBucket.PROVIDER_OR_PLATFORM_ERROR,
    ],
    [
      { status: 'VOIDED', classification: null, verificationVerdict: null },
      NotChargedReason.NO_USABLE_RESULT,
      WithheldBucket.PROVIDER_OR_PLATFORM_ERROR,
    ],
    [
      { status: 'EXPIRED', classification: null, verificationVerdict: null },
      NotChargedReason.EXPIRED,
      WithheldBucket.PROVIDER_OR_PLATFORM_ERROR,
    ],
  ])('%o → %s', (outcome, reason, bucket) => {
    expect(notChargedReason(outcome)).toEqual({ reason, bucket });
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
});
