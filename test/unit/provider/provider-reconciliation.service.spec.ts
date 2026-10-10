import { ConfigService } from '@nestjs/config';

import {
  CREDITED_SQL,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import { ProviderPayoutRepository } from '@database/postgres/repositories/provider-payout.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { ApiErrorCode } from '@shared/api';
import { CallReconciliationClass } from '@modules/provider/domain/call-reconciliation';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { ProviderReconciliationService } from '@modules/provider/services/provider-reconciliation.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { fakeQueryBuilder } from './helpers/fake-query-builder';

const PROVIDER = 'org-55555555-5555-5555-8555-555555555555';
const USDC = ASSET_IDS.USDC_SOLANA_MAINNET;
const OTHER = ASSET_IDS.USDC_SOLANA_DEVNET;
const WINDOW = { from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' };

interface GroupRow {
  callClass: string;
  status: string;
  classification: string | null;
  asset: string;
  decimals: string;
  calls: string;
  credited: string;
  providerAmount: string;
  platformFee: string;
  awaitingRedemption?: boolean;
}

interface BatchRow {
  asset: string;
  decimals: string;
  count: string;
  paid: string;
}

function group(overrides: Partial<GroupRow>): GroupRow {
  return {
    callClass: 'PAID',
    status: 'SETTLED',
    classification: null,
    asset: USDC,
    decimals: '6',
    calls: '0',
    credited: '0',
    providerAmount: '0',
    platformFee: '0',
    ...overrides,
  };
}

function batch(overrides: Partial<BatchRow>): BatchRow {
  return { asset: USDC, decimals: '6', count: '0', paid: '0', ...overrides };
}

function build(
  groupRows: GroupRow[],
  batchRows: BatchRow[] = [],
  configValues: Record<string, string> = {},
) {
  const groupsFake = fakeQueryBuilder(groupRows);
  const batchesFake = fakeQueryBuilder(batchRows);
  const intents = {
    createQueryBuilder: jest.fn().mockReturnValue(groupsFake.qb),
  } as unknown as PaymentIntentRepository;
  const payouts = {
    createQueryBuilder: jest.fn().mockReturnValue(batchesFake.qb),
  } as unknown as ProviderPayoutRepository;
  const config = {
    get: jest.fn((key: string) => configValues[key]),
  } as unknown as ConfigService;

  return {
    service: new ProviderReconciliationService(intents, payouts, config),
    groupsFake,
    batchesFake,
  };
}

function classOf<T extends { class: string }>(breakdown: T[], cls: CallReconciliationClass): T {
  return breakdown.find((row) => row.class === cls)!;
}

describe('ProviderReconciliationService — scoping', () => {
  it('scopes calls the way ProviderEarningsService does: organizationId tautology + provider_id filter', async () => {
    const { service, groupsFake } = build([]);

    await service.getReconciliation(PROVIDER, WINDOW);

    const sql = groupsFake.wheres.map((w) => w.sql).join(' ');
    expect(sql).toMatch(/organizationId/);
    expect(groupsFake.wheres.some((w) => w.params.providerId === PROVIDER)).toBe(true);
  });

  it('scopes payout batches directly by organizationId — a provider’s own table, not cross-org', async () => {
    const { service, batchesFake } = build([]);

    await service.getReconciliation(PROVIDER, WINDOW);

    expect(batchesFake.wheres.some((w) => w.params.providerId === PROVIDER)).toBe(true);
    expect(
      batchesFake.wheres.some((w) => w.sql.includes('status') && w.params.recorded === 'RECORDED'),
    ).toBe(true);
  });
});

describe('ProviderReconciliationService — every class present, exhaustive by construction', () => {
  it('lists all ten classes at a real zero for an empty window', async () => {
    const { service } = build([]);

    const result = await service.getReconciliation(PROVIDER, WINDOW);

    expect(result.classBreakdown).toHaveLength(10);
    const classes = result.classBreakdown.map((r) => r.class).sort();
    expect(classes).toEqual(
      [
        CallReconciliationClass.PAID_CREDITED,
        CallReconciliationClass.PAID_AWAITING_REDEMPTION,
        CallReconciliationClass.PAID_UNCREDITED,
        CallReconciliationClass.FREE,
        CallReconciliationClass.TEST,
        CallReconciliationClass.EXPLORATION,
        CallReconciliationClass.EXCLUDED,
        CallReconciliationClass.SYSTEM_ERROR,
        CallReconciliationClass.REQUEST_ERROR,
        CallReconciliationClass.PENDING,
      ].sort(),
    );
    for (const row of result.classBreakdown) {
      expect(row.calls).toBe(0);
      expect(row.note.length).toBeGreaterThan(0);
    }
    expect(result.callCount).toBe(0);
  });

  it('TEST, EXPLORATION and EXCLUDED render as real zeros even with other traffic present — no producer yet', async () => {
    const { service } = build([
      group({
        callClass: 'PAID',
        status: 'SETTLED',
        calls: '10',
        credited: '1000',
        providerAmount: '900',
        platformFee: '100',
      }),
    ]);

    const result = await service.getReconciliation(PROVIDER, WINDOW);

    expect(classOf(result.classBreakdown, CallReconciliationClass.TEST).calls).toBe(0);
    expect(classOf(result.classBreakdown, CallReconciliationClass.EXPLORATION).calls).toBe(0);
    expect(classOf(result.classBreakdown, CallReconciliationClass.EXCLUDED).calls).toBe(0);
    expect(classOf(result.classBreakdown, CallReconciliationClass.PAID_CREDITED).calls).toBe(10);
  });
});

describe('ProviderReconciliationService — classification agrees with the shared domain function', () => {
  it('routes each (call_class, status, classification) combination to the class the domain function defines', async () => {
    const rows: GroupRow[] = [
      group({
        callClass: 'PAID',
        status: 'SETTLED',
        calls: '5',
        credited: '500',
        providerAmount: '450',
        platformFee: '50',
      }),
      group({ callClass: 'PAID', status: 'REFUNDED', calls: '3' }),
      group({ callClass: 'FREE', status: 'SETTLED', calls: '7' }),
      group({ callClass: 'TEST', status: 'CREATED', calls: '2' }),
      group({
        callClass: 'EXPLORATION',
        status: 'SETTLED',
        calls: '4',
        credited: '4',
        providerAmount: '4',
        platformFee: '0',
      }),
      group({ callClass: 'PAID', status: 'VOIDED', classification: 'SYSTEM_ERROR', calls: '6' }),
      group({ callClass: 'PAID', status: 'EXPIRED', classification: 'REQUEST_ERROR', calls: '1' }),
      group({ callClass: 'PAID', status: 'FUNDS_SECURED', calls: '9' }),
    ];
    const { service } = build(rows);

    const result = await service.getReconciliation(PROVIDER, WINDOW);
    const breakdown = result.classBreakdown;

    expect(classOf(breakdown, CallReconciliationClass.PAID_CREDITED).calls).toBe(5);
    expect(classOf(breakdown, CallReconciliationClass.PAID_UNCREDITED).calls).toBe(3);
    expect(classOf(breakdown, CallReconciliationClass.FREE).calls).toBe(7);
    expect(classOf(breakdown, CallReconciliationClass.TEST).calls).toBe(2);
    expect(classOf(breakdown, CallReconciliationClass.EXPLORATION).calls).toBe(4);
    expect(classOf(breakdown, CallReconciliationClass.SYSTEM_ERROR).calls).toBe(6);
    expect(classOf(breakdown, CallReconciliationClass.REQUEST_ERROR).calls).toBe(1);
    expect(classOf(breakdown, CallReconciliationClass.PENDING).calls).toBe(9);

    expect(result.callCount).toBe(5 + 3 + 7 + 2 + 4 + 6 + 1 + 9);
    expect(result.unexplained.calls).toBe(0);
    expect(result.unexplained.reference).toBeNull();
  });

  it('sums gross/platformTake/net from the same rows credited carries, holding the price = provider + fee invariant', async () => {
    const rows: GroupRow[] = [
      group({
        callClass: 'PAID',
        status: 'SETTLED',
        calls: '2',
        credited: '2000',
        providerAmount: '1800',
        platformFee: '200',
      }),
      group({
        callClass: 'EXPLORATION',
        status: 'SETTLED',
        calls: '1',
        credited: '10',
        providerAmount: '9',
        platformFee: '1',
      }),
    ];
    const { service } = build(rows);

    const result = await service.getReconciliation(PROVIDER, WINDOW);

    expect(result.gross).toEqual({ amount: '2010', asset: USDC, decimals: 6 });
    expect(result.platformTake).toEqual({ amount: '201', asset: USDC, decimals: 6 });
    expect(result.net).toEqual({ amount: '1809', asset: USDC, decimals: 6 });
  });
});

describe('ProviderReconciliationService — rail B awaiting redemption', () => {
  it('counts a settled, unredeemed group apart and keeps it out of gross, take and net', async () => {
    const rows: GroupRow[] = [
      group({
        callClass: 'PAID',
        status: 'SETTLED',
        calls: '3',
        credited: '3000',
        providerAmount: '2700',
        platformFee: '300',
        awaitingRedemption: true,
      }),
      group({
        callClass: 'PAID',
        status: 'SETTLED',
        calls: '1',
        credited: '1000',
        providerAmount: '900',
        platformFee: '100',
        awaitingRedemption: false,
      }),
    ];
    const { service } = build(rows);

    const result = await service.getReconciliation(PROVIDER, WINDOW);
    const breakdown = result.classBreakdown;

    expect(classOf(breakdown, CallReconciliationClass.PAID_AWAITING_REDEMPTION).calls).toBe(3);
    expect(classOf(breakdown, CallReconciliationClass.PAID_CREDITED).calls).toBe(1);
    expect(result.gross).toEqual({ amount: '1000', asset: USDC, decimals: 6 });
    expect(result.net).toEqual({ amount: '900', asset: USDC, decimals: 6 });
    expect(result.callCount).toBe(4);
  });
});

describe('ProviderReconciliationService — money figures count committed holds only', () => {
  // Same rule as earnings: gross / take / net must match the PROVIDER_CREDIT
  // ledger, which is written exactly when a SETTLED intent's hold is committed.
  it('sums credited, providerAmount and platformFee only over SETTLED intents whose hold was committed', async () => {
    const { service, groupsFake } = build([]);

    await service.getReconciliation(PROVIDER, WINDOW);

    for (const alias of ['credited', 'providerAmount', 'platformFee']) {
      const expr = groupsFake.selects.find((s) => s.alias === alias)?.expr ?? '';
      expect(expr).toContain(CREDITED_SQL);
    }
  });
});

describe('ProviderReconciliationService — unexplained is a real, referenced bucket, never a silent drop', () => {
  it('counts a group whose money field cannot be parsed as unexplained instead of throwing or dropping it', async () => {
    const rows: GroupRow[] = [
      group({ callClass: 'PAID', status: 'SETTLED', calls: '4', credited: 'not-a-number' }),
      group({ callClass: 'FREE', status: 'SETTLED', calls: '6' }),
    ];
    const { service } = build(rows);

    const result = await service.getReconciliation(PROVIDER, WINDOW);

    expect(result.unexplained.calls).toBe(4);
    expect(result.unexplained.reference).toMatch(/^rec_[0-9a-f]{8}$/);
    // The corrupted group's calls are not folded into PAID_CREDITED or any
    // other class — they are absent from every class bucket and present only
    // in `unexplained`.
    expect(classOf(result.classBreakdown, CallReconciliationClass.PAID_CREDITED).calls).toBe(0);
    expect(classOf(result.classBreakdown, CallReconciliationClass.FREE).calls).toBe(6);
    // callCount still counts every call, including the unexplained one.
    expect(result.callCount).toBe(10);
  });

  it('is a real zero — not merely absent — when nothing is unexplained', async () => {
    const { service } = build([group({ callClass: 'PAID', status: 'SETTLED', calls: '1' })]);

    const result = await service.getReconciliation(PROVIDER, WINDOW);

    expect(result.unexplained).toEqual({ calls: 0, reference: null });
  });
});

describe('ProviderReconciliationService — batches and reconciliation', () => {
  it('reconciles when net equals the sum of RECORDED payouts in the window', async () => {
    const groupRows = [
      group({
        callClass: 'PAID',
        status: 'SETTLED',
        calls: '1',
        credited: '1000',
        providerAmount: '900',
        platformFee: '100',
      }),
    ];
    const batchRows = [batch({ count: '3', paid: '900' })];
    const { service } = build(groupRows, batchRows);

    const result = await service.getReconciliation(PROVIDER, WINDOW);

    expect(result.batches).toEqual({
      count: 3,
      paid: { amount: '900', asset: USDC, decimals: 6 },
      reconciles: true,
    });
  });

  it('flags a mismatch rather than asserting reconciliation that is not there', async () => {
    const groupRows = [
      group({
        callClass: 'PAID',
        status: 'SETTLED',
        calls: '1',
        credited: '1000',
        providerAmount: '900',
        platformFee: '100',
      }),
    ];
    const batchRows = [batch({ count: '1', paid: '500' })];
    const { service } = build(groupRows, batchRows);

    const result = await service.getReconciliation(PROVIDER, WINDOW);

    expect(result.batches.reconciles).toBe(false);
  });

  it('reconciles trivially (0 == 0) for a window with no calls and no payouts', async () => {
    const { service } = build([]);

    const result = await service.getReconciliation(PROVIDER, WINDOW);

    expect(result.batches).toEqual({ count: 0, paid: null, reconciles: true });
  });
});

describe('ProviderReconciliationService — asset resolution', () => {
  it('is null, and every Money field is null, for a window with no rows and no ?asset=', async () => {
    const { service } = build([]);

    const result = await service.getReconciliation(PROVIDER, WINDOW);

    expect(result.asset).toBeNull();
    expect(result.gross).toBeNull();
    expect(result.platformTake).toBeNull();
    expect(result.net).toBeNull();
    expect(
      classOf(result.classBreakdown, CallReconciliationClass.PAID_CREDITED).credited,
    ).toBeNull();
  });

  it('still denominates a zero window when the caller named the asset', async () => {
    const { service } = build([]);

    const result = await service.getReconciliation(PROVIDER, { ...WINDOW, asset: USDC });

    expect(result.asset).toBe(USDC);
    expect(result.gross).toEqual({ amount: '0', asset: USDC, decimals: 0 });
  });

  it('refuses a window spanning more than one asset across calls and payouts with no ?asset=', async () => {
    const { service } = build([group({ asset: USDC })], [batch({ asset: OTHER })]);

    await expectErrorCodeAsync(
      () => service.getReconciliation(PROVIDER, WINDOW),
      ProviderErrorCode.PROVIDER_MULTIPLE_ASSETS,
    );
  });

  it('accepts a mixed window when ?asset= disambiguates it', async () => {
    const { service } = build([group({ asset: USDC })], [batch({ asset: OTHER })]);

    const result = await service.getReconciliation(PROVIDER, { ...WINDOW, asset: USDC });

    expect(result.asset).toBe(USDC);
  });

  it('rejects an asset filter that is not a CAIP-19 id', async () => {
    const { service } = build([]);

    await expectErrorCodeAsync(
      () => service.getReconciliation(PROVIDER, { ...WINDOW, asset: 'not-a-caip-19-id' }),
      ApiErrorCode.API_INVALID_FILTER,
    );
  });
});

describe('ProviderReconciliationService — invalid range', () => {
  it('refuses from >= to', async () => {
    const { service } = build([]);

    await expectErrorCodeAsync(
      () => service.getReconciliation(PROVIDER, { from: WINDOW.to, to: WINDOW.from }),
      ProviderErrorCode.PROVIDER_INVALID_TIME_RANGE,
    );
  });
});

describe('ProviderReconciliationService — platform take rate', () => {
  it('defaults to 10%, the same default provider-terms.ts uses for PROVIDER_TERMS_TAKE_RATE_PERCENT', async () => {
    const { service } = build([]);

    const result = await service.getReconciliation(PROVIDER, WINDOW);

    expect(result.platformTakeRatePercent).toBe(10);
  });

  it('reads the configured rate rather than hardcoding it', async () => {
    const { service } = build([], [], { PROVIDER_TERMS_TAKE_RATE_PERCENT: '15' });

    const result = await service.getReconciliation(PROVIDER, WINDOW);

    expect(result.platformTakeRatePercent).toBe(15);
  });
});
