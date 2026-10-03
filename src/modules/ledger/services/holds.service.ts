import { Injectable } from '@nestjs/common';

import { LedgerHoldRepository } from '@database/postgres/repositories/ledger-hold.repository';
import { LedgerHoldEntity } from '@database/postgres/entities/ledger-hold.entity';
import { AssetId } from '@modules/chains/ports/caip.types';
import { MoneyUtil } from '@shared/utils/money.util';
import { CursorPageDto, ListSpec, asInstant, paginate } from '@shared/api';

import { HoldDto, ListHoldsQueryDto } from '../dto/list-holds.dto';
import { LedgerHoldStatus } from '../ports/ledger.types';

/**
 * Holds, enumerated. `LedgerHoldRepository` already exists for the
 * ledger's own state machine (`LedgerHoldService`); this is the read-only list
 * view over the same table, for the screens the org's holds rather than the
 * reservation logic.
 */
const HOLD_LIST: ListSpec = {
  alias: 'hold',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'hold.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: LedgerHoldEntity) => row.createdAt),
    },
  },
};

@Injectable()
export class HoldsService {
  constructor(private readonly holds: LedgerHoldRepository) {}

  async list(organizationId: string, query: ListHoldsQueryDto): Promise<CursorPageDto<HoldDto>> {
    const qb = this.holds
      .createQueryBuilder('hold')
      .where('hold.organizationId = :organizationId', { organizationId });

    if (query.status?.length) {
      qb.andWhere('hold.status IN (:...statuses)', { statuses: query.status });
    } else {
      qb.andWhere('hold.status = :openStatus', { openStatus: LedgerHoldStatus.OPEN });
    }

    const page = await paginate(qb, query, HOLD_LIST);
    return page.map(toHoldDto);
  }
}

function toHoldDto(row: LedgerHoldEntity): HoldDto {
  const money = MoneyUtil.of(row.amount, row.assetId as AssetId, row.decimals);
  const ageSeconds = Math.max(0, Math.floor((Date.now() - row.createdAt.getTime()) / 1000));

  return {
    id: row.id,
    intentId: row.intentId,
    amount: { amount: money.amount, asset: money.asset, decimals: money.decimals },
    status: row.status as LedgerHoldStatus,
    createdAt: row.createdAt.toISOString(),
    ageSeconds,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}
