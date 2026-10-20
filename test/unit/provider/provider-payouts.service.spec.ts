import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { RAIL_A_BOOK_CREDIT_TX_REF } from '@modules/ledger/ports/ledger.types';
import { ProviderPaymentKind } from '@modules/provider/dto/get-provider-payouts.dto';
import { ProviderPayoutsService } from '@modules/provider/services/provider-payouts.service';
import { ApiErrorCode, SortDirection } from '@shared/api';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { fakeQueryBuilder, fakeRepository } from './helpers/fake-query-builder';

const ORG = 'org-55555555-5555-4555-8555-555555555555';
const USDC = ASSET_IDS.USDC_SOLANA_MAINNET;

function redemption(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000002',
    kind: 'REDEMPTION',
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

function build(redemptions: unknown[] = []) {
  const redemptionFake = fakeQueryBuilder(redemptions);
  const ledgerEntries = fakeRepository([redemptionFake.qb]) as unknown as LedgerEntryRepository;
  return { service: new ProviderPayoutsService(ledgerEntries), redemptionFake };
}

const QUERY = { limit: 25, order: SortDirection.DESC } as any;

describe('ProviderPayoutsService — an ordinary organization-scoped list', () => {
  it('scopes the list to the caller’s own organization, not cross-org', async () => {
    const { service, redemptionFake } = build();

    await service.listPayouts(ORG, QUERY);

    expect(redemptionFake.wheres[0]).toEqual({
      sql: 'entry.organizationId = :organizationId',
      params: { organizationId: ORG },
    });
  });
});

describe('ProviderPayoutsService — rail-B redemptions are payments (D18)', () => {
  it('groups PROVIDER_CREDIT by transaction, leaving out book-only credits', async () => {
    const { service, redemptionFake } = build();

    await service.listPayouts(ORG, QUERY);

    // A synthetic ref (per-payer seq) is its own payment, never merged with another.
    expect(redemptionFake.groups[0]).toMatch(
      /^CASE WHEN .*:unobservedPrefix.*:heldCollectedPrefix.* THEN entry\.id::text ELSE entry\.chainTxRef END$/,
    );
    expect(redemptionFake.params.unobservedPrefix).toBe('unobserved:');
    expect(redemptionFake.params.heldCollectedPrefix).toBe('held_collected:');
    expect(redemptionFake.params.creditType).toBe('PROVIDER_CREDIT');
    expect(redemptionFake.params.railARef).toBe(RAIL_A_BOOK_CREDIT_TX_REF);
    const sql = redemptionFake.wheres.map((w) => w.sql).join(' | ');
    expect(sql).toContain('entry.chainTxRef IS NOT NULL');
    expect(sql).toContain('<> :railARef');
  });

  it('windows redemptions on their first credit', async () => {
    const { service, redemptionFake } = build();
    const from = new Date('2026-10-01T00:00:00.000Z');
    const to = new Date('2026-11-01T00:00:00.000Z');

    await service.listPayouts(ORG, { ...QUERY, from, to });

    expect(redemptionFake.havings[0].sql).toContain('MIN(entry.createdAt) >= :from');
    expect(redemptionFake.havings[0].sql).toContain('MIN(entry.createdAt) < :to');
    // `from` is also a whole-transaction pre-filter on the rows; `to` is not.
    const wheres = redemptionFake.wheres.map((w) => w.sql).join(' | ');
    expect(wheres).toContain('entry.created_at >= :fromBound::timestamptz AND NOT EXISTS (');
    expect(wheres).not.toContain(':to');
  });

  it('refuses an empty or inverted window', async () => {
    const { service } = build();
    const at = new Date('2026-10-01T00:00:00.000Z');

    await expectErrorCodeAsync(
      () => service.listPayouts(ORG, { ...QUERY, from: at, to: at }),
      ApiErrorCode.API_INVALID_TIME_RANGE,
    );
  });

  it('lists redemptions newest first, each with its call count', async () => {
    const { service } = build([
      redemption(),
      redemption({
        id: '00000000-0000-4000-8000-000000000003',
        chainTxRef: '0xbbb',
        amount: '18000',
        calls: '1',
        createdAt: new Date('2026-08-09T00:00:00.000Z'),
        at: '2026-08-09T00:00:00.000000Z',
      }),
    ]);

    const page = await service.listPayouts(ORG, QUERY);

    expect(page.items).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000002',
        kind: ProviderPaymentKind.REDEMPTION,
        amount: { amount: '180000', asset: USDC, decimals: 6 },
        chainTxRef: '0xaaa',
        calls: 2,
        createdAt: new Date('2026-08-11T00:00:00.000Z'),
      },
      expect.objectContaining({ chainTxRef: '0xbbb', calls: 1 }),
    ]);
    expect(page.pageInfo.hasMore).toBe(false);
  });

  it('cuts the list at the limit and hands back a cursor that resumes it', async () => {
    const { service } = build([
      redemption(),
      redemption({
        id: '00000000-0000-4000-8000-000000000003',
        createdAt: new Date('2026-08-09T00:00:00.000Z'),
        at: '2026-08-09T00:00:00.000000Z',
      }),
    ]);

    const page = await service.listPayouts(ORG, { limit: 1, order: SortDirection.DESC } as any);

    expect(page.items.map((item) => item.kind)).toEqual([ProviderPaymentKind.REDEMPTION]);
    expect(page.pageInfo.hasMore).toBe(true);

    const next = build();
    await next.service.listPayouts(ORG, {
      limit: 1,
      order: SortDirection.DESC,
      cursor: page.pageInfo.nextCursor,
    } as any);
    expect(next.redemptionFake.havings[0]?.params).toEqual({
      afterAt: '2026-08-11T00:00:00.000000Z',
      afterId: '00000000-0000-4000-8000-000000000002',
    });
  });

  it('refuses a cursor that is not one of its own', async () => {
    const { service } = build();

    await expectErrorCodeAsync(
      () => service.listPayouts(ORG, { ...QUERY, cursor: 'not-a-cursor' }),
      ApiErrorCode.API_INVALID_CURSOR,
    );
  });
});
