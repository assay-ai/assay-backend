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
