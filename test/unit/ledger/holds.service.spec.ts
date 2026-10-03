import { SortDirection } from '@shared/api';
import { LedgerHoldRepository } from '@database/postgres/repositories/ledger-hold.repository';
import { LedgerHoldStatus } from '@modules/ledger/ports/ledger.types';
import { ListHoldsQueryDto } from '@modules/ledger/dto/list-holds.dto';
import { HoldsService } from '@modules/ledger/services/holds.service';

import { ORG, USDC, USDC_DECIMALS } from './helpers/entries';
import { fakeQueryBuilder } from './helpers/fake-query-builder';

function holdRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'hold-1',
    organizationId: ORG,
    accountId: 'acct',
    amount: '1000',
    assetId: USDC,
    decimals: USDC_DECIMALS,
    status: LedgerHoldStatus.OPEN,
    intentId: 'intent-1',
    createEntryId: 'entry-1',
    resolveEntryId: null,
    expiresAt: null,
    createdAt: new Date('2026-08-10T10:00:00.000Z'),
    updatedAt: new Date('2026-08-10T10:00:00.000Z'),
    ...overrides,
  };
}

function query(overrides: Partial<ListHoldsQueryDto> = {}): ListHoldsQueryDto {
  return Object.assign(
    new ListHoldsQueryDto(),
    { limit: 10, order: SortDirection.DESC },
    overrides,
  );
}

function build(rows: ReturnType<typeof holdRow>[]) {
  const fake = fakeQueryBuilder(rows);
  const holds = {
    createQueryBuilder: jest.fn().mockReturnValue(fake.qb),
  } as unknown as LedgerHoldRepository;

  return { service: new HoldsService(holds), fake };
}

describe('HoldsService.list', () => {
  it('scopes to the caller organization', async () => {
    const { service, fake } = build([holdRow()]);

    await service.list(ORG, query());

    const orgWhere = fake.wheres.find((w) => w.sql.includes('hold.organizationId'));
    expect(orgWhere?.params).toEqual({ organizationId: ORG });
  });

  it('defaults to OPEN holds when no status filter is given', async () => {
    const { service, fake } = build([holdRow()]);

    await service.list(ORG, query());

    const statusWhere = fake.wheres.find((w) => w.sql.includes('hold.status ='));
    expect(statusWhere?.params).toEqual({ openStatus: LedgerHoldStatus.OPEN });
  });

  it('filters by the requested statuses instead of the OPEN default when given', async () => {
    const { service, fake } = build([holdRow({ status: LedgerHoldStatus.RELEASED })]);

    await service.list(
      ORG,
      query({ status: [LedgerHoldStatus.RELEASED, LedgerHoldStatus.COMMITTED] }),
    );

    const statusWhere = fake.wheres.find((w) => w.sql.includes('hold.status IN'));
    expect(statusWhere?.params).toEqual({
      statuses: [LedgerHoldStatus.RELEASED, LedgerHoldStatus.COMMITTED],
    });
    expect(fake.wheres.some((w) => w.sql.includes('hold.status ='))).toBe(false);
  });

  it('maps a row to the wire shape: money, ISO timestamps, and a computed age', async () => {
    const createdAt = new Date(Date.now() - 5000);
    const { service } = build([holdRow({ createdAt })]);

    const page = await service.list(ORG, query());

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: 'hold-1',
      intentId: 'intent-1',
      amount: { amount: '1000', asset: USDC, decimals: USDC_DECIMALS },
      status: LedgerHoldStatus.OPEN,
      createdAt: createdAt.toISOString(),
      expiresAt: null,
    });
    expect(page.items[0].ageSeconds).toBeGreaterThanOrEqual(4);
  });

  it('renders a non-null expiresAt as ISO-8601', async () => {
    const expiresAt = new Date('2026-08-11T10:00:00.000Z');
    const { service } = build([holdRow({ expiresAt })]);

    const page = await service.list(ORG, query());

    expect(page.items[0].expiresAt).toBe(expiresAt.toISOString());
  });

  it('signals hasMore via pageInfo when more than `limit` rows come back', async () => {
    const rows = [
      holdRow({ id: 'a', createdAt: new Date('2026-08-10T10:00:02.000Z') }),
      holdRow({ id: 'b', createdAt: new Date('2026-08-10T10:00:01.000Z') }),
    ];
    const { service } = build(rows);

    const page = await service.list(ORG, query({ limit: 1 }));

    expect(page.items).toHaveLength(1);
    expect(page.pageInfo.hasMore).toBe(true);
    expect(page.pageInfo.nextCursor).not.toBeNull();
  });
});
