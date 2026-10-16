import {
  CREDITED_SQL,
  DEBT_OUTSTANDING_SQL,
  FORFEITED_SQL,
  PLATFORM_ABSORBED_SQL,
  WRITTEN_OFF_SQL,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { ApiErrorCode } from '@shared/api';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { ProviderEarningsGroupBy } from '@modules/provider/dto/get-provider-earnings.dto';
import { ProviderEarningsService } from '@modules/provider/services/provider-earnings.service';
import { PLATFORM_ABSORBED_TX_REF_PREFIX } from '@modules/payment/services/voucher-redemption.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { fakeQueryBuilder } from './helpers/fake-query-builder';

const PROVIDER = 'org-44444444-4444-4444-8444-444444444444';
const USDC = ASSET_IDS.USDC_SOLANA_MAINNET;
const WINDOW = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-08T00:00:00.000Z' };

interface Row {
  key: string;
  asset: string;
  decimals: string;
  calls: string;
  earned: string;
  platformFee: string;
  withheld: string;
  withheldCalls: string;
  forfeited: string;
  forfeitedCalls: string;
  debtOutstanding: string;
  debtOutstandingCalls: string;
  uncollected: string;
  uncollectedCalls: string;
}

function row(overrides: Partial<Row>): Row {
  return {
    key: 'tool-1',
    asset: USDC,
    decimals: '6',
    calls: '0',
    earned: '0',
    platformFee: '0',
    withheld: '0',
    withheldCalls: '0',
    forfeited: '0',
    forfeitedCalls: '0',
    debtOutstanding: '0',
    debtOutstandingCalls: '0',
    uncollected: '0',
    uncollectedCalls: '0',
    ...overrides,
  };
}

function build(rows: Row[]) {
  const fake = fakeQueryBuilder(rows);
  const intents = {
    createQueryBuilder: jest.fn().mockReturnValue(fake.qb),
  } as unknown as PaymentIntentRepository;
  return { service: new ProviderEarningsService(intents), fake };
}

describe('ProviderEarningsService — cross-organization, scoped by provider_id', () => {
  it('references organization_id (scope guard) and filters by provider_id', async () => {
    const { service, fake } = build([]);

    await service.getEarnings(PROVIDER, { ...WINDOW, groupBy: ProviderEarningsGroupBy.DAY });

    const sql = fake.wheres.map((w) => w.sql).join(' ');
    expect(sql).toMatch(/organizationId/);
    expect(fake.wheres.some((w) => w.params.providerId === PROVIDER)).toBe(true);
  });
});

describe('ProviderEarningsService — group totals reconcile exactly to the overall totals', () => {
  it('sums calls, earned, platformFee and withheld across groups', async () => {
    const rows = [
      row({
        key: 'tool-1',
        calls: '100',
        earned: '9000',
        platformFee: '1000',
        withheld: '500',
        withheldCalls: '2',
      }),
      row({
        key: 'tool-2',
        calls: '37',
        earned: '3701',
        platformFee: '400',
        withheld: '0',
        withheldCalls: '0',
      }),
    ];
    const { service } = build(rows);

    const earnings = await service.getEarnings(PROVIDER, {
      ...WINDOW,
      groupBy: ProviderEarningsGroupBy.TOOL,
    });

    expect(earnings.groups).toHaveLength(2);
    expect(earnings.totals.calls).toBe(137);
    expect(earnings.totals.earned.amount).toBe('12701');
    expect(earnings.totals.platformFee.amount).toBe('1400');
    expect(earnings.totals.withheld.amount).toBe('500');
    expect(earnings.totals.withheldCalls).toBe(2);
    expect(earnings.asset).toBe(USDC);
  });

  it('is exactly zero-reconciled for an empty window', async () => {
    const { service } = build([]);

    const earnings = await service.getEarnings(PROVIDER, {
      ...WINDOW,
      groupBy: ProviderEarningsGroupBy.DAY,
    });

    expect(earnings.groups).toEqual([]);

    // The counts are real zeros — nothing happened, and that is knowable.
    expect(earnings.totals.calls).toBe(0);
    expect(earnings.totals.withheldCalls).toBe(0);

    // The *amounts* are not. With no rows and no `asset` filter there is no
    // asset to denominate a zero in, and `{ amount: '0', asset: '' }` would be
    // a malformed CAIP-19 id wearing the shape of a valid one — a client that
    // renders it gets a blank symbol, one that looks it up gets a miss it has
    // no branch for. Absent is the only honest answer.
    expect(earnings.totals.earned).toBeNull();
    expect(earnings.totals.platformFee).toBeNull();
    expect(earnings.totals.withheld).toBeNull();
    expect(earnings.asset).toBeNull();
  });

  it('still denominates a zero window when the caller named the asset', async () => {
    const { service } = build([]);

    const earnings = await service.getEarnings(PROVIDER, {
      ...WINDOW,
      groupBy: ProviderEarningsGroupBy.DAY,
      asset: USDC,
    });

    // Here the asset is known despite there being no rows, so a zero is
    // expressible and is the more useful answer.
    expect(earnings.asset).toBe(USDC);
    expect(earnings.totals.earned).toEqual({ amount: '0', asset: USDC, decimals: 0 });
  });
});

describe('ProviderEarningsService — asset resolution', () => {
  it('refuses a window spanning more than one asset with no ?asset= filter', async () => {
    const OTHER = ASSET_IDS.USDC_SOLANA_DEVNET;
    const { service } = build([
      row({ key: 'tool-1', asset: USDC }),
      row({ key: 'tool-2', asset: OTHER }),
    ]);

    await expectErrorCodeAsync(
      () => service.getEarnings(PROVIDER, { ...WINDOW, groupBy: ProviderEarningsGroupBy.TOOL }),
      ProviderErrorCode.PROVIDER_MULTIPLE_ASSETS,
    );
  });

  it('accepts a mixed window when ?asset= disambiguates it', async () => {
    const { service } = build([row({ key: 'tool-1', asset: USDC })]);

    const earnings = await service.getEarnings(PROVIDER, {
      ...WINDOW,
      groupBy: ProviderEarningsGroupBy.TOOL,
      asset: USDC,
    });

    expect(earnings.asset).toBe(USDC);
  });

  it('rejects an asset filter that is not a CAIP-19 id', async () => {
    const { service } = build([]);

    await expectErrorCodeAsync(
      () =>
        service.getEarnings(PROVIDER, {
          ...WINDOW,
          groupBy: ProviderEarningsGroupBy.TOOL,
          asset: 'not-a-caip-19-id',
        }),
      ApiErrorCode.API_INVALID_FILTER,
    );
  });
});

describe('ProviderEarningsService — invalid range', () => {
  it('refuses from >= to', async () => {
    const { service } = build([]);

    await expectErrorCodeAsync(
      () =>
        service.getEarnings(PROVIDER, {
          from: WINDOW.to,
          to: WINDOW.from,
          groupBy: ProviderEarningsGroupBy.DAY,
        }),
      ProviderErrorCode.PROVIDER_INVALID_TIME_RANGE,
    );
  });
});

describe('ProviderEarningsService — earned means credited (committed hold)', () => {
  // A SETTLED intent only carries a PROVIDER_CREDIT once its hold is committed:
  // rail A inline in `resolve()`, rail B when `redeem_voucher` lands. A SETTLED
  // row with no hold, or whose hold is still open, is not money the provider
  // holds, so earnings must not count it — or they disagree with the ledger.
  it('sums earned and platformFee only over SETTLED intents whose hold was committed', async () => {
    const { service, fake } = build([]);

    await service.getEarnings(PROVIDER, { ...WINDOW, groupBy: ProviderEarningsGroupBy.TOOL });

    for (const alias of ['earned', 'platformFee']) {
      const expr = fake.selects.find((s) => s.alias === alias)?.expr ?? '';
      expect(expr).toContain(CREDITED_SQL);
      expect(expr).toMatch(/:settledStatus/);
    }
    expect(CREDITED_SQL).toMatch(/hold_id IS NOT NULL/);
    expect(CREDITED_SQL).toMatch(/hold_released_at IS NOT NULL/);
  });

  it('never counts a voucher the provider forfeited as earned (review M2)', () => {
    // A forfeit RELEASES the hold, which also sets hold_released_at; only the
    // forfeit marker tells it from a commit.
    expect(CREDITED_SQL).toContain(FORFEITED_SQL);
    expect(CREDITED_SQL).toMatch(/AND NOT \(COALESCE\(/);
    expect(FORFEITED_SQL).toContain("'provider_forfeit:%'");
  });
});

describe('ProviderEarningsService — the platform never pays or owes a provider (M4)', () => {
  it('reports forfeited, outstanding-debt and uncollected calls apart from earned', async () => {
    const { service, fake } = build([
      row({
        calls: '51',
        earned: '4230000',
        platformFee: '470000',
        forfeited: '90000',
        forfeitedCalls: '1',
        debtOutstanding: '180000',
        debtOutstandingCalls: '2',
        uncollected: '360000',
        uncollectedCalls: '4',
      }),
    ]);

    const earnings = await service.getEarnings(PROVIDER, {
      ...WINDOW,
      groupBy: ProviderEarningsGroupBy.TOOL,
    });

    expect(earnings.totals.earned.amount).toBe('4230000');
    expect(earnings.totals.forfeited).toEqual({ amount: '90000', asset: USDC, decimals: 6 });
    expect(earnings.totals.forfeitedCalls).toBe(1);
    expect(earnings.totals.debtOutstanding).toEqual({ amount: '180000', asset: USDC, decimals: 6 });
    expect(earnings.totals.debtOutstandingCalls).toBe(2);
    expect(earnings.totals.uncollected).toEqual({ amount: '360000', asset: USDC, decimals: 6 });
    expect(earnings.groups[0].uncollectedCalls).toBe(4);
    expect(earnings.totals).not.toHaveProperty('absorbed');

    const expr = (alias: string) => fake.selects.find((s) => s.alias === alias)?.expr ?? '';
    // Earned and the fee are credited-only, and credited leaves every
    // non-collected call out — a legacy absorb included.
    expect(expr('earned')).toContain(CREDITED_SQL);
    expect(expr('platformFee')).toContain(CREDITED_SQL);
    expect(CREDITED_SQL).toContain(PLATFORM_ABSORBED_SQL);
    expect(expr('forfeited')).toContain(FORFEITED_SQL);
    expect(expr('debtOutstanding')).toContain(DEBT_OUTSTANDING_SQL);
    expect(expr('uncollected')).toContain(WRITTEN_OFF_SQL);
    expect(expr('uncollected')).toContain(PLATFORM_ABSORBED_SQL);
    expect(PLATFORM_ABSORBED_SQL).toContain(`'${PLATFORM_ABSORBED_TX_REF_PREFIX}%'`);
  });

  it('is null amounts, and zero counts, for an empty undenominated window', async () => {
    const { service } = build([]);

    const earnings = await service.getEarnings(PROVIDER, {
      ...WINDOW,
      groupBy: ProviderEarningsGroupBy.DAY,
    });

    expect(earnings.totals.forfeited).toBeNull();
    expect(earnings.totals.uncollected).toBeNull();
    expect(earnings.totals.debtOutstanding).toBeNull();
    expect(earnings.totals.forfeitedCalls).toBe(0);
  });
});
