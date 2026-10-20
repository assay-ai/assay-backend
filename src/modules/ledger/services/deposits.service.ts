import { Injectable } from '@nestjs/common';

import { DepositIntentRepository } from '@database/postgres/repositories/deposit-intent.repository';
import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { DepositIntentEntity } from '@database/postgres/entities/deposit-intent.entity';
import { AssetId } from '@modules/chains/ports/caip.types';
import { PaymentErrors } from '@modules/payment/errors/payment.errors';
import { DepositIntentStatus } from '@modules/payment/ports/deposit.types';
import { MoneyUtil } from '@shared/utils/money.util';
import { CursorPageDto, ListSpec, applyTimeWindow, asInstant, paginate } from '@shared/api';

import { DepositDto, DepositFinality, ListDepositsQueryDto } from '../dto/list-deposits.dto';

/** `GET /deposits` — the deposit history behind the funding screen. */
const DEPOSIT_LIST: ListSpec = {
  alias: 'intent',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'intent.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: DepositIntentEntity) => row.createdAt),
    },
  },
};

@Injectable()
export class DepositsService {
  constructor(
    private readonly deposits: DepositIntentRepository,
    private readonly entries: LedgerEntryRepository,
  ) {}

  async list(
    organizationId: string,
    query: ListDepositsQueryDto,
  ): Promise<CursorPageDto<DepositDto>> {
    const qb = this.deposits
      .createQueryBuilder('intent')
      .where('intent.organizationId = :organizationId', { organizationId });

    applyTimeWindow(qb, query, DEPOSIT_LIST);

    if (query.status?.length) {
      qb.andWhere('intent.status IN (:...statuses)', { statuses: query.status });
    }

    const page = await paginate(qb, query, DEPOSIT_LIST);
    const resolutions = await this.resolutions(organizationId, page.items);
    return page.map((row) => toDepositDto(row, resolutions));
  }

  /**
   * One deposit, in the row shape `list` returns — what a pending-deposit wait
   * polls instead of `GET /balances`. Another organization's id is the same
   * 404 as an unknown one.
   */
  async getOne(organizationId: string, depositId: string): Promise<DepositDto> {
    const row = await this.deposits.findOneBy({ organizationId, id: depositId });
    if (!row) {
      throw PaymentErrors.depositIntentNotFound({ id: depositId });
    }
    return toDepositDto(row, await this.resolutions(organizationId, [row]));
  }

  /** The finality verdicts of the `SETTLED` rows among `rows`; one query, none when there are none. */
  private resolutions(
    organizationId: string,
    rows: readonly DepositIntentEntity[],
  ): Promise<Map<string, string>> {
    const settled = rows.filter((row) => row.status === DepositIntentStatus.SETTLED);
    return this.entries.depositResolutions(
      organizationId,
      settled.map((row) => row.id),
    );
  }
}

function finalityOf(
  row: DepositIntentEntity,
  resolutions: ReadonlyMap<string, string>,
): DepositFinality | null {
  if (row.status !== DepositIntentStatus.SETTLED) return null;
  switch (resolutions.get(row.id)) {
    case 'DEPOSIT_CONFIRM':
    case 'DEPOSIT':
      return DepositFinality.CONFIRMED;
    case 'DEPOSIT_REJECT':
      return DepositFinality.REJECTED;
    default:
      return DepositFinality.PENDING;
  }
}

function toDepositDto(
  row: DepositIntentEntity,
  resolutions: ReadonlyMap<string, string>,
): DepositDto {
  const asset = row.assetId as AssetId;
  const requested = MoneyUtil.of(row.requestedAmount, asset, row.decimals);
  const settled =
    row.settledAmount !== null ? MoneyUtil.of(row.settledAmount, asset, row.decimals) : null;

  return {
    id: row.id,
    status: row.status as DepositIntentStatus,
    statusReason: row.statusReason,
    agentId: row.agentId,
    agentAccount: row.agentAccount,
    requestedAmount: {
      amount: requested.amount,
      asset: requested.asset,
      decimals: requested.decimals,
    },
    settledAmount: settled
      ? { amount: settled.amount, asset: settled.asset, decimals: settled.decimals }
      : null,
    chainId: row.chainId,
    chainTxRef: row.chainTxRef,
    finality: finalityOf(row, resolutions),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
