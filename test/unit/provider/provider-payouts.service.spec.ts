import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { ProviderPayoutsService } from '@modules/provider/services/provider-payouts.service';
import { SortDirection } from '@shared/api';

import { fakeQueryBuilder } from './helpers/fake-query-builder';

const ORG = 'org-55555555-5555-4555-8555-555555555555';
const USDC = ASSET_IDS.USDC_SOLANA_MAINNET;

function entry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'entry-1',
    batchId: 'batch-1',
    amount: '1000000',
    assetId: USDC,
    decimals: 6,
    chainTxRef: null,
    createdAt: new Date('2026-08-10T00:00:00.000Z'),
    ...overrides,
  };
}

function build(rows: ReturnType<typeof entry>[]) {
  const fake = fakeQueryBuilder(rows);
  const ledgerEntries = {
    createQueryBuilder: jest.fn().mockReturnValue(fake.qb),
  } as unknown as LedgerEntryRepository;
  return { service: new ProviderPayoutsService(ledgerEntries), fake };
}

describe('ProviderPayoutsService — an ordinary organization-scoped list', () => {
  it('scopes to the caller’s own organization, not cross-org', async () => {
    const { service, fake } = build([]);

    await service.listPayouts(ORG, { limit: 25, order: SortDirection.DESC } as any);

    expect(fake.wheres[0]).toEqual({
      sql: 'entry.organizationId = :organizationId',
      params: { organizationId: ORG },
    });
  });

  it('filters to PAYOUT entries that carry a batch id', async () => {
    const { service, fake } = build([]);

    await service.listPayouts(ORG, { limit: 25, order: SortDirection.DESC } as any);

    const sql = fake.wheres.map((w) => w.sql).join(' | ');
    expect(sql).toContain('entry.entryType = :entryType');
    expect(sql).toContain('entry.batchId IS NOT NULL');
    expect(fake.wheres.some((w) => w.params.entryType === 'PAYOUT')).toBe(true);
  });

  it('renders each row as { id, batchId, amount, chainTxRef, createdAt }', async () => {
    const rows = [entry({ id: 'e1', batchId: 'b1' }), entry({ id: 'e2', batchId: 'b1' })];
    const { service } = build(rows);

    const page = await service.listPayouts(ORG, { limit: 25, order: SortDirection.DESC } as any);

    expect(page.items).toEqual([
      {
        id: 'e1',
        batchId: 'b1',
        amount: { amount: '1000000', asset: USDC, decimals: 6 },
        chainTxRef: null,
        createdAt: rows[0].createdAt,
      },
      {
        id: 'e2',
        batchId: 'b1',
        amount: { amount: '1000000', asset: USDC, decimals: 6 },
        chainTxRef: null,
        createdAt: rows[1].createdAt,
      },
    ]);
  });
});
