import { SortDirection } from '@shared/api';
import { LedgerHoldRepository } from '@database/postgres/repositories/ledger-hold.repository';
import { LedgerHoldStatus } from '@modules/ledger/ports/ledger.types';
import { ListHoldsQueryDto } from '@modules/ledger/dto/list-holds.dto';
import { HoldsService, stageOf } from '@modules/ledger/services/holds.service';

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

describe('HoldsService.list stage (BUG-R2-BUY-01)', () => {
  function withIntents(
    rows: ReturnType<typeof holdRow>[],
    intents: Array<{ id: string; status: string; debt?: boolean; onChain?: boolean }>,
  ) {
    const fake = fakeQueryBuilder(rows);
    const query = jest.fn().mockResolvedValue(intents);
    const holds = {
      createQueryBuilder: jest.fn().mockReturnValue(fake.qb),
      manager: { query },
    } as unknown as LedgerHoldRepository;
    return { service: new HoldsService(holds), query };
  }

  it('splits settled calls: SETTLING while unsettled, ON_CHAIN_HOLD once in the on-chain hold', async () => {
    const rows = [
      holdRow({ id: 'h-check', intentId: 'i-check', createdAt: new Date('2026-11-01T13:00:04Z') }),
      holdRow({
        id: 'h-settling',
        intentId: 'i-settling',
        createdAt: new Date('2026-11-01T13:00:03Z'),
      }),
      holdRow({
        id: 'h-bucket',
        intentId: 'i-bucket',
        createdAt: new Date('2026-11-01T13:00:02Z'),
      }),
      holdRow({ id: 'h-debt', intentId: 'i-debt', createdAt: new Date('2026-11-01T13:00:01Z') }),
    ];
    const { service, query: sql } = withIntents(rows, [
      { id: 'i-check', status: 'VERIFYING', debt: false, onChain: false },
      { id: 'i-settling', status: 'SETTLED', debt: false, onChain: false },
      { id: 'i-bucket', status: 'SETTLED', debt: false, onChain: true },
      { id: 'i-debt', status: 'SETTLED', debt: true, onChain: false },
    ]);

    const page = await service.list(ORG, query());

    const stages = Object.fromEntries(page.items.map((item) => [item.id, item.stage]));
    expect(stages).toEqual({
      'h-check': 'CHECKING',
      'h-settling': 'SETTLING',
      'h-bucket': 'ON_CHAIN_HOLD',
      'h-debt': 'DEBT',
    });
    expect(String(sql.mock.calls[0][0])).toContain(`"held_status" = 'HELD'`);
  });

  it("accepts the driver's string booleans", async () => {
    const { service } = withIntents(
      [holdRow({ intentId: 'i-1' })],
      [{ id: 'i-1', status: 'SETTLED', debt: 'false', onChain: 'true' } as never],
    );
    const page = await service.list(ORG, query());
    expect(page.items[0].stage).toBe('ON_CHAIN_HOLD');
  });

  it('never stages a hold that is not open', () => {
    expect(stageOf({ status: LedgerHoldStatus.COMMITTED }, 'ON_CHAIN_HOLD')).toBeNull();
    expect(stageOf({ status: LedgerHoldStatus.OPEN }, 'ON_CHAIN_HOLD')).toBe('ON_CHAIN_HOLD');
  });
});
