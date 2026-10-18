import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { LEGACY_POOLED_VAULT_TX_REF } from '@modules/ledger/ports/ledger.types';
import { PLATFORM_ABSORBED_TX_REF_PREFIX } from '@modules/payment/services/voucher-redemption.service';
import { ProviderPaymentKind } from '@modules/provider/dto/get-provider-payouts.dto';
import { ProviderPayoutsService } from '@modules/provider/services/provider-payouts.service';
import { ApiErrorCode, SortDirection } from '@shared/api';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { fakeQueryBuilder, fakeRepository } from './helpers/fake-query-builder';

const ORG = 'org-55555555-5555-4555-8555-555555555555';
const USDC = ASSET_IDS.USDC_SOLANA_MAINNET;

function batch(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'BATCH',
    batchId: 'batch-1',
    amount: '1000000',
    asset: USDC,
    decimals: 6,
    chainTxRef: null,
    calls: null,
    createdAt: new Date('2026-08-10T00:00:00.000Z'),
    at: '2026-08-10T00:00:00.000000Z',
    ...overrides,
  };
}

function redemption(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000002',
    kind: 'REDEMPTION',
    batchId: null,
    amount: '180000',
    asset: USDC,
    decimals: '6',
    chainTxRef: '0xaaa',
    calls: '2',
    createdAt: new Date('2026-08-11T00:00:00.000Z'),
    at: '2026-08-11T00:00:00.000000Z',
    ...overrides,
  };
}

function build(batches: unknown[], redemptions: unknown[] = []) {
  const batchFake = fakeQueryBuilder(batches);
  const redemptionFake = fakeQueryBuilder(redemptions);
  const ledgerEntries = fakeRepository([
    batchFake.qb,
    redemptionFake.qb,
  ]) as unknown as LedgerEntryRepository;
  return { service: new ProviderPayoutsService(ledgerEntries), batchFake, redemptionFake };
}

const QUERY = { limit: 25, order: SortDirection.DESC } as any;

describe('ProviderPayoutsService — an ordinary organization-scoped list', () => {
  it('scopes both kinds to the caller’s own organization, not cross-org', async () => {
    const { service, batchFake, redemptionFake } = build([]);

    await service.listPayouts(ORG, QUERY);

    for (const fake of [batchFake, redemptionFake]) {
      expect(fake.wheres[0]).toEqual({
        sql: 'entry.organizationId = :organizationId',
        params: { organizationId: ORG },
      });
    }
  });

  it('reads batches from PAYOUT entries that carry a batch id', async () => {
    const { service, batchFake } = build([]);

    await service.listPayouts(ORG, QUERY);

    const sql = batchFake.wheres.map((w) => w.sql).join(' | ');
    expect(sql).toContain('entry.entryType = :entryType');
    expect(sql).toContain('entry.batchId IS NOT NULL');
    expect(batchFake.wheres.some((w) => w.params.entryType === 'PAYOUT')).toBe(true);
  });
});

describe('ProviderPayoutsService — rail-B redemptions are payments (D18)', () => {
  it('groups PROVIDER_CREDIT by transaction, leaving out absorbed and book-only credits', async () => {
    const { service, redemptionFake } = build([]);

    await service.listPayouts(ORG, QUERY);

    // A synthetic ref (per-payer seq) is its own payment, never merged with another.
    expect(redemptionFake.groups[0]).toMatch(
      /^CASE WHEN .*:unobservedPrefix.*:heldCollectedPrefix.* THEN entry\.id::text ELSE entry\.chainTxRef END$/,
    );
    expect(redemptionFake.params.unobservedPrefix).toBe('unobserved:');
    expect(redemptionFake.params.heldCollectedPrefix).toBe('held_collected:');
    expect(redemptionFake.params.creditType).toBe('PROVIDER_CREDIT');
    expect(redemptionFake.params.absorbedPrefix).toBe(PLATFORM_ABSORBED_TX_REF_PREFIX);
    expect(redemptionFake.params.legacyRef).toBe(LEGACY_POOLED_VAULT_TX_REF);
    const sql = redemptionFake.wheres.map((w) => w.sql).join(' | ');
    expect(sql).toContain('entry.chainTxRef IS NOT NULL');
    // starts_with, not LIKE: the `_` in the prefix is no wildcard.
    expect(sql).toContain('NOT starts_with(entry.chainTxRef, :absorbedPrefix)');
    expect(sql).not.toMatch(/LIKE/);
    expect(sql).toContain('<> :legacyRef');
  });

  it('windows batches on their entry and redemptions on their first credit', async () => {
    const { service, batchFake, redemptionFake } = build([]);
    const from = new Date('2026-10-01T00:00:00.000Z');
    const to = new Date('2026-11-01T00:00:00.000Z');

    await service.listPayouts(ORG, { ...QUERY, from, to });

    expect(batchFake.wheres).toEqual(
      expect.arrayContaining([
        { sql: 'entry.createdAt >= :from', params: { from } },
        { sql: 'entry.createdAt < :to', params: { to } },
      ]),
    );
    expect(redemptionFake.havings[0].sql).toContain('MIN(entry.createdAt) >= :from');
    expect(redemptionFake.havings[0].sql).toContain('MIN(entry.createdAt) < :to');
  });

  it('refuses an empty or inverted window', async () => {
    const { service } = build([]);
    const at = new Date('2026-10-01T00:00:00.000Z');

    await expectErrorCodeAsync(
      () => service.listPayouts(ORG, { ...QUERY, from: at, to: at }),
      ApiErrorCode.API_INVALID_TIME_RANGE,
    );
  });

  it('merges both kinds newest first, each with its kind and call count', async () => {
    const { service } = build(
      [batch({ calls: 12 })],
      [
        redemption(),
        redemption({
          id: '00000000-0000-4000-8000-000000000003',
          chainTxRef: '0xbbb',
          amount: '18000',
          calls: '1',
          createdAt: new Date('2026-08-09T00:00:00.000Z'),
          at: '2026-08-09T00:00:00.000000Z',
        }),
      ],
    );

    const page = await service.listPayouts(ORG, QUERY);

    expect(page.items).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000002',
        kind: ProviderPaymentKind.REDEMPTION,
        batchId: null,
        amount: { amount: '180000', asset: USDC, decimals: 6 },
        chainTxRef: '0xaaa',
        calls: 2,
        createdAt: new Date('2026-08-11T00:00:00.000Z'),
      },
      {
        id: '00000000-0000-4000-8000-000000000001',
        kind: ProviderPaymentKind.BATCH,
        batchId: 'batch-1',
        amount: { amount: '1000000', asset: USDC, decimals: 6 },
        chainTxRef: null,
        calls: 12,
        createdAt: new Date('2026-08-10T00:00:00.000Z'),
      },
      expect.objectContaining({ chainTxRef: '0xbbb', calls: 1 }),
    ]);
    expect(page.pageInfo.hasMore).toBe(false);
  });

  it('cuts the merged list at the limit and hands back a cursor that resumes both kinds', async () => {
    const { service } = build([batch()], [redemption()]);

    const page = await service.listPayouts(ORG, { limit: 1, order: SortDirection.DESC } as any);

    expect(page.items.map((item) => item.kind)).toEqual([ProviderPaymentKind.REDEMPTION]);
    expect(page.pageInfo.hasMore).toBe(true);

    const next = build([], []);
    await next.service.listPayouts(ORG, {
      limit: 1,
      order: SortDirection.DESC,
      cursor: page.pageInfo.nextCursor,
    } as any);
    expect(next.batchFake.wheres.at(-1)?.params).toEqual({
      afterAt: '2026-08-11T00:00:00.000000Z',
      afterId: '00000000-0000-4000-8000-000000000002',
    });
    expect(next.redemptionFake.havings[0]?.params).toEqual({
      afterAt: '2026-08-11T00:00:00.000000Z',
      afterId: '00000000-0000-4000-8000-000000000002',
    });
  });

  it('refuses a cursor that is not one of its own', async () => {
    const { service } = build([]);

    await expectErrorCodeAsync(
      () => service.listPayouts(ORG, { ...QUERY, cursor: 'not-a-cursor' }),
      ApiErrorCode.API_INVALID_CURSOR,
    );
  });
});
