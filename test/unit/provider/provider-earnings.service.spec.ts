import {
  CREDITED_SQL,
  DEBT_OUTSTANDING_SQL,
  FORFEITED_SQL,
  PLATFORM_ABSORBED_SQL,
  VOIDED_SQL,
  WRITTEN_OFF_SQL,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { ApiErrorCode } from '@shared/api';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import {
  CallClassValue,
  CallReconciliationClass,
  IntentStatusValue,
  ResponseClassValue,
  classifyForReconciliation,
  isNotCredited,
} from '@modules/provider/domain/call-reconciliation';
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
  forfeited: string;
  forfeitedCalls: string;
  debtOutstanding: string;
  debtOutstandingCalls: string;
  uncollected: string;
  uncollectedCalls: string;
  pendingInWindow: string;
  pendingInWindowCalls: string;
}

function row(overrides: Partial<Row>): Row {
  return {
    key: 'tool-1',
    asset: USDC,
    decimals: '6',
    calls: '0',
    earned: '0',
    platformFee: '0',
    forfeited: '0',
    forfeitedCalls: '0',
    debtOutstanding: '0',
    debtOutstandingCalls: '0',
    uncollected: '0',
    uncollectedCalls: '0',
    pendingInWindow: '0',
    pendingInWindowCalls: '0',
    ...overrides,
  };
}

/** One group of calls sharing every input the classifier reads (the second query). */
interface ClassRow {
  key: string;
  asset: string;
  decimals: string;
  callClass: string;
  status: string;
  classification: string | null;
  awaitingRedemption: boolean | string | null;
  uncollected: boolean | string | null;
  debtOutstanding: boolean | string | null;
  forfeited: boolean | string | null;
  voided: boolean | string | null;
  calls: string;
  providerAmount: string;
}

function classRow(overrides: Partial<ClassRow>): ClassRow {
  return {
    key: 'tool-1',
    asset: USDC,
    decimals: '6',
    callClass: 'PAID',
    status: 'SETTLED',
    classification: 'DATA_RESULT',
    awaitingRedemption: false,
    uncollected: false,
    debtOutstanding: false,
    forfeited: false,
    voided: false,
    calls: '1',
    providerAmount: '0',
    ...overrides,
  };
}

function build(rows: Row[], classRows: ClassRow[] = []) {
  const fake = fakeQueryBuilder(rows);
  const classFake = fakeQueryBuilder(classRows);
  const intents = {
    createQueryBuilder: jest.fn().mockReturnValueOnce(fake.qb).mockReturnValueOnce(classFake.qb),
  } as unknown as PaymentIntentRepository;
  return { service: new ProviderEarningsService(intents), fake, classFake };
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
      }),
      row({
        key: 'tool-2',
        calls: '37',
        earned: '3701',
        platformFee: '400',
      }),
    ];
    const { service } = build(rows, [
      classRow({ key: 'tool-1', status: 'REFUNDED', calls: '2', providerAmount: '500' }),
    ]);

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
        pendingInWindow: '270000',
        pendingInWindowCalls: '3',
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
    // Held for the dispute window (G3.B1): pending, not earned, not debt.
    expect(earnings.totals.pendingInWindow).toEqual({ amount: '270000', asset: USDC, decimals: 6 });
    expect(earnings.totals.pendingInWindowCalls).toBe(3);
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

describe('ProviderEarningsService — not credited is the export classifier, held or not (D17)', () => {
  // UX review 2026-10-18, D-P0-1: the summary required a hold and read
  // "14 calls · $0.54" while its own reasons (the export) read 22 · $0.74.
  const classes = [
    // Not credited: a failed check, held and unheld, and a voided buyer debt.
    classRow({ status: 'REFUNDED', calls: '4', providerAmount: '153000' }),
    classRow({ status: 'REFUNDED', classification: null, calls: '8', providerAmount: '200000' }),
    classRow({ status: 'SETTLED', voided: true, calls: '1', providerAmount: '45000' }),
    // Not credited: endpoint errors and refused requests.
    classRow({
      status: 'VOIDED',
      classification: 'SYSTEM_ERROR',
      calls: '8',
      providerAmount: '297000',
    }),
    classRow({ status: 'EXPIRED', classification: null, calls: '1', providerAmount: '9000' }),
    classRow({
      status: 'VOIDED',
      classification: 'REQUEST_ERROR',
      calls: '2',
      providerAmount: '90000',
    }),
    // Credited, pending, or passed-but-unpaid: reported elsewhere.
    classRow({ status: 'SETTLED', calls: '81', providerAmount: '6084000' }),
    classRow({ status: 'SETTLED', uncollected: true, calls: '5', providerAmount: '450000' }),
    classRow({ status: 'SETTLED', forfeited: 'true', calls: '1', providerAmount: '90000' }),
    classRow({ status: 'SETTLED', debtOutstanding: true, calls: '2', providerAmount: '180000' }),
    classRow({ status: 'SETTLED', awaitingRedemption: true, calls: '3', providerAmount: '270000' }),
    classRow({ status: 'VERIFYING', classification: null, calls: '1', providerAmount: '90000' }),
    // Free calls are never "not credited", whatever their outcome.
    classRow({ callClass: 'FREE', status: 'REFUNDED', calls: '6', providerAmount: '0' }),
  ];

  it('counts unheld REFUNDED and SETTLED+voided calls, and the summary is the sum of its reasons', async () => {
    const { service } = build([row({ key: 'tool-1', calls: '123' })], classes);

    const earnings = await service.getEarnings(PROVIDER, {
      ...WINDOW,
      groupBy: ProviderEarningsGroupBy.TOOL,
    });

    const money = (amount: string) => ({ amount, asset: USDC, decimals: 6 });
    expect(earnings.totals.withheldByClass).toEqual([
      { class: CallReconciliationClass.PAID_UNCREDITED, calls: 13, amount: money('398000') },
      { class: CallReconciliationClass.SYSTEM_ERROR, calls: 9, amount: money('306000') },
      { class: CallReconciliationClass.REQUEST_ERROR, calls: 2, amount: money('90000') },
    ]);
    expect(earnings.totals.withheldCalls).toBe(24);
    expect(earnings.totals.withheld).toEqual(money('794000'));
    expect(earnings.groups[0].withheldCalls).toBe(24);
  });

  it('agrees with classifyForReconciliation call for call over the fixture set', async () => {
    const { service } = build([row({ key: 'tool-1', calls: '123' })], classes);
    const earnings = await service.getEarnings(PROVIDER, {
      ...WINDOW,
      groupBy: ProviderEarningsGroupBy.TOOL,
    });

    const expected = new Map<string, number>();
    for (const c of classes) {
      const cls = classifyForReconciliation({
        callClass: c.callClass as CallClassValue,
        status: c.status as IntentStatusValue,
        classification: c.classification as ResponseClassValue,
        awaitingRedemption: c.awaitingRedemption === true || c.awaitingRedemption === 'true',
        uncollected: c.uncollected === true || c.uncollected === 'true',
        debtOutstanding: c.debtOutstanding === true || c.debtOutstanding === 'true',
        forfeited: c.forfeited === true || c.forfeited === 'true',
        voided: c.voided === true || c.voided === 'true',
      });
      if (isNotCredited(cls)) expected.set(cls, (expected.get(cls) ?? 0) + Number(c.calls));
    }
    for (const reason of earnings.totals.withheldByClass) {
      expect(reason.calls).toBe(expected.get(reason.class) ?? 0);
    }
  });

  it('groups the classifier inputs per report group, and keeps groups apart', async () => {
    const { service, classFake } = build(
      [row({ key: 'tool-1', calls: '3' }), row({ key: 'tool-2', calls: '1' })],
      [
        classRow({ key: 'tool-1', status: 'REFUNDED', calls: '3', providerAmount: '300' }),
        classRow({
          key: 'tool-2',
          status: 'VOIDED',
          classification: 'SYSTEM_ERROR',
          providerAmount: '7',
        }),
      ],
    );

    const earnings = await service.getEarnings(PROVIDER, {
      ...WINDOW,
      groupBy: ProviderEarningsGroupBy.TOOL,
    });

    expect(earnings.groups.map((g) => [g.key, g.withheldCalls, g.withheld?.amount])).toEqual([
      ['tool-1', 3, '300'],
      ['tool-2', 1, '7'],
    ]);
    // The second query is scoped like the first and groups by every classifier input.
    expect(classFake.wheres.some((w) => w.params.providerId === PROVIDER)).toBe(true);
    for (const column of [
      'intent.callClass',
      'intent.status',
      'intent.classification',
      VOIDED_SQL,
    ]) {
      expect(classFake.groups).toContain(column);
    }
    // No hold condition anywhere in it.
    expect(classFake.selects.map((s) => s.expr).join(' ')).not.toMatch(/holdId IS NOT NULL/);
  });
});
