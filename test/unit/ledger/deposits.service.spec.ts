import { SortDirection } from '@shared/api';
import { DepositIntentRepository } from '@database/postgres/repositories/deposit-intent.repository';
import { DepositIntentStatus } from '@modules/payment/ports/deposit.types';
import { ListDepositsQueryDto } from '@modules/ledger/dto/list-deposits.dto';
import { DepositsService } from '@modules/ledger/services/deposits.service';

import { ORG, USDC, USDC_DECIMALS } from './helpers/entries';
import { fakeQueryBuilder } from './helpers/fake-query-builder';

function depositRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'dep-1',
    organizationId: ORG,
    status: DepositIntentStatus.CREATED,
    statusReason: null,
    agentId: 'agent-1',
    agentAccount: 'solana:acct',
    assetId: USDC,
    decimals: USDC_DECIMALS,
    requestedAmount: '5000000',
    settledAmount: null,
    chainId: 'solana:mainnet',
    chainTxRef: null,
    expiresAt: new Date('2026-08-10T10:05:00.000Z'),
    createdAt: new Date('2026-08-10T10:00:00.000Z'),
    updatedAt: new Date('2026-08-10T10:00:00.000Z'),
    ...overrides,
  };
}

function query(overrides: Partial<ListDepositsQueryDto> = {}): ListDepositsQueryDto {
  return Object.assign(
    new ListDepositsQueryDto(),
    { limit: 10, order: SortDirection.DESC },
    overrides,
  );
}

function build(rows: ReturnType<typeof depositRow>[]) {
  const fake = fakeQueryBuilder(rows);
  const deposits = {
    createQueryBuilder: jest.fn().mockReturnValue(fake.qb),
  } as unknown as DepositIntentRepository;

  return { service: new DepositsService(deposits), fake };
}

describe('DepositsService.list', () => {
  it('scopes to the caller organization', async () => {
    const { service, fake } = build([depositRow()]);

    await service.list(ORG, query());

    const orgWhere = fake.wheres.find((w) => w.sql.includes('intent.organizationId'));
    expect(orgWhere?.params).toEqual({ organizationId: ORG });
  });

  it('applies no status filter when none is given', async () => {
    const { service, fake } = build([depositRow()]);

    await service.list(ORG, query());

    expect(fake.wheres.some((w) => w.sql.includes('intent.status'))).toBe(false);
  });

  it('filters by the requested statuses when given', async () => {
    const { service, fake } = build([depositRow({ status: DepositIntentStatus.SETTLED })]);

    await service.list(
      ORG,
      query({ status: [DepositIntentStatus.SETTLED, DepositIntentStatus.FAILED] }),
    );

    const statusWhere = fake.wheres.find((w) => w.sql.includes('intent.status IN'));
    expect(statusWhere?.params).toEqual({
      statuses: [DepositIntentStatus.SETTLED, DepositIntentStatus.FAILED],
    });
  });

  it('maps requestedAmount and a null settledAmount to the wire shape', async () => {
    const { service } = build([depositRow()]);

    const page = await service.list(ORG, query());

    expect(page.items[0]).toMatchObject({
      id: 'dep-1',
      status: DepositIntentStatus.CREATED,
      agentId: 'agent-1',
      agentAccount: 'solana:acct',
      requestedAmount: { amount: '5000000', asset: USDC, decimals: USDC_DECIMALS },
      settledAmount: null,
      chainId: 'solana:mainnet',
      chainTxRef: null,
    });
  });

  it('renders the observed settledAmount, which may differ from requestedAmount', async () => {
    const { service } = build([
      depositRow({
        settledAmount: '5000100',
        chainTxRef: '5j7s…',
        status: DepositIntentStatus.SETTLED,
      }),
    ]);

    const page = await service.list(ORG, query());

    expect(page.items[0].settledAmount).toEqual({
      amount: '5000100',
      asset: USDC,
      decimals: USDC_DECIMALS,
    });
    expect(page.items[0].chainTxRef).toBe('5j7s…');
  });
});

describe('DepositsService.getOne', () => {
  function withRow(row: ReturnType<typeof depositRow> | null) {
    const findOneBy = jest.fn().mockResolvedValue(row);
    const service = new DepositsService({ findOneBy } as unknown as DepositIntentRepository);
    return { service, findOneBy };
  }

  it('reads one row by id within the organization, in the list row’s shape', async () => {
    const row = depositRow({ status: DepositIntentStatus.SETTLED, settledAmount: '5000000' });
    const { service, findOneBy } = withRow(row);
    const list = build([row]).service;

    const one = await service.getOne(ORG, 'dep-1');

    expect(findOneBy).toHaveBeenCalledWith({ organizationId: ORG, id: 'dep-1' });
    expect(one).toEqual((await list.list(ORG, query())).items[0]);
  });

  it('is PAYMENT_DEPOSIT_NOT_FOUND when the organization has no such deposit', async () => {
    await expect(withRow(null).service.getOne(ORG, 'dep-x')).rejects.toMatchObject({
      errorCode: 'PAYMENT_DEPOSIT_NOT_FOUND',
    });
  });
});
