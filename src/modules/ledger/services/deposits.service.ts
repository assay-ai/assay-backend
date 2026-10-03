import { Injectable } from '@nestjs/common';

import { DepositIntentRepository } from '@database/postgres/repositories/deposit-intent.repository';
import { DepositIntentEntity } from '@database/postgres/entities/deposit-intent.entity';
import { AssetId } from '@modules/chains/ports/caip.types';
import { DepositIntentStatus } from '@modules/payment/ports/deposit.types';
import { MoneyUtil } from '@shared/utils/money.util';
import { CursorPageDto, ListSpec, applyTimeWindow, asInstant, paginate } from '@shared/api';

import { DepositDto, ListDepositsQueryDto } from '../dto/list-deposits.dto';

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
  constructor(private readonly deposits: DepositIntentRepository) {}

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
    return page.map(toDepositDto);
  }
}

function toDepositDto(row: DepositIntentEntity): DepositDto {
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
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
