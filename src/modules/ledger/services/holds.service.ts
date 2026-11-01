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
    const stages = await this.stagesOf(
      organizationId,
      page.items.map((row) => row.intentId).filter((id): id is string => !!id),
    );
    return page.map((row) => ({
      ...toHoldDto(row),
      stage: stageOf(row, stages.get(row.intentId)),
    }));
  }

  /** The call's status behind each hold, in one read (SPEC-H H-2: split "checking" from "settling"). */
  private async stagesOf(
    organizationId: string,
    intentIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (intentIds.length === 0 || typeof this.holds.manager?.query !== 'function') return new Map();
    const rows = (await this.holds.manager.query(
      `SELECT "id", "status",
              ("redemption_lapsed_at" IS NOT NULL AND "redemption_replaced_at" IS NULL) AS "debt",
              ("held_status" = 'HELD') AS "onChain"
         FROM "payment_intents"
        WHERE "organization_id" = $1 AND "id" = ANY($2::uuid[])`,
      [organizationId, [...intentIds]],
    )) as { id: string; status: string; debt?: boolean | string; onChain?: boolean | string }[];
    // A lapsed call's hold is a buyer debt, not a payment in progress (M10).
    // A call already in the escrow's on-chain hold (a landed channel settle's
    // bucket, or a per-call redeem into the hold) is out of the buyer's escrow:
    // not "settling" any more (BUG-R2-BUY-01).
    return new Map(
      rows.map((row) => [
        row.id,
        row.debt === true || row.debt === 'true'
          ? 'DEBT'
          : row.onChain === true || row.onChain === 'true'
            ? ON_CHAIN_HOLD
            : row.status,
      ]),
    );
  }
}

const ON_CHAIN_HOLD = 'ON_CHAIN_HOLD';

/**
 * `CHECKING` while the call is still being admitted, served or verified;
 * `SETTLING` once it passed and only the on-chain settlement (redemption or
 * channel settle) remains, the money still in the buyer's escrow;
 * `ON_CHAIN_HOLD` once that settlement landed: the money left the escrow
 * for the on-chain dispute hold (a channel bucket, or the per-call hold) and
 * waits for the collect (not in `openHolds`); `DEBT` when the settlement
 * lapsed and the buyer owes it (settled only by re-signing); `null` for a
 * hold that is not open.
 */
export function stageOf(
  row: Pick<LedgerHoldEntity, 'status'>,
  intentStatus: string | undefined,
): HoldStage | null {
  if (row.status !== LedgerHoldStatus.OPEN || !intentStatus) return null;
  if (intentStatus === 'DEBT') return 'DEBT';
  if (intentStatus === ON_CHAIN_HOLD) return 'ON_CHAIN_HOLD';
  return intentStatus === 'SETTLED' ? 'SETTLING' : 'CHECKING';
}

export type HoldStage = 'CHECKING' | 'SETTLING' | 'ON_CHAIN_HOLD' | 'DEBT';

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
