import { disputeWindowEndOf } from '../constants/collection-hold.constants';
import { Injectable } from '@nestjs/common';
import { In } from 'typeorm';

import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { VerificationRecordEntity } from '@database/postgres/entities/verification-record.entity';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { VerdictStatus } from '@modules/verification/domain/verdict';
import {
  CursorPageDto,
  ListSpec,
  applyTimeWindow,
  asExactNumber,
  asInstant,
  paginate,
} from '@shared/api';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  CollectionState,
  collectionStateOf,
  debtStateOf,
  isChargedWhenSettled,
} from '../domain/collection';
import { ListToolCallsQueryDto, ToolCallDto } from '../dto/list-tool-calls.dto';
import { PaymentErrors } from '../errors/payment.errors';
import { PaymentIntentStatus } from '../ports/payment.types';

/**
 * Declared next to the query this drives, per `backend/docs/api-list-contract.md`.
 *
 * `priceAmount` is sortable as well as `createdAt` — `docs/api-list-contract.md`
 * rule 2 requires an index ending in the tiebreak for **every** sortable field,
 * which is why the migration adds both `idx_payment_intents_tool_calls_feed`
 * and `..._price_feed` rather than just the default-sort one.
 */
const TOOL_CALLS_LIST: ListSpec = {
  alias: 'intent',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'intent.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: PaymentIntentEntity) => row.createdAt),
    },
    priceAmount: {
      column: 'intent.price_amount',
      type: 'numeric',
      valueOf: asExactNumber((row: PaymentIntentEntity) => row.priceAmount),
    },
  },
};

/**
 * `GET /api/v1/tool-calls` and `GET /api/v1/tool-calls/:intentId`.
 *
 * The call list every buyer screen opens with — `payment_intents` LEFT JOIN
 * `verification_records`. The join is used two ways, deliberately kept apart:
 *
 * - **In the query**, only to let `verdict[]` filter on `verification_records
 *   .verdict_status` without pulling the whole evidence row into the page.
 *   `leftJoin` (no `addSelect`) registers the alias for `WHERE`/`ORDER BY`
 *   without changing what `paginate()`'s `getMany()` returns.
 * - **After the page comes back**, a single batched `IN (...)` fetch attaches
 *   the verdict to each row. `PaymentIntentEntity` has no TypeORM relation to
 *   `VerificationRecordEntity` — neither entity is changed for this read —
 *   so a mapped join is not an option, and this
 *   is the shape `docs/api-list-contract.md`'s machinery actually supports:
 *   `paginate()` takes one query builder over one entity.
 *
 * `GET /tool-calls/:intentId` is deliberately **not** the full evidence
 * receipt — that is `GET /receipts/:intentId`
 * (`verification/services/receipt.service.ts`), a different endpoint this
 * module does not own. This one returns the same row shape as the list, for
 * the id column any UI reasonably links from a table.
 */
@Injectable()
export class ToolCallsService {
  constructor(
    private readonly paymentIntents: PaymentIntentRepository,
    private readonly verificationRecords: VerificationRecordRepository,
  ) {}

  async list(
    organizationId: string,
    query: ListToolCallsQueryDto,
  ): Promise<CursorPageDto<ToolCallDto>> {
    const qb = this.paymentIntents
      .createQueryBuilder('intent')
      .where('intent.organizationId = :organizationId', { organizationId })
      // Registers the alias for the verdict filter below; no columns are
      // selected off it, so `getMany()` still returns plain `PaymentIntentEntity`
      // rows and `paginate()` needs to know nothing about the join.
      .leftJoin(VerificationRecordEntity, 'record', 'record.intentId = intent.id');

    if (query.status?.length) {
      qb.andWhere('intent.status IN (:...statuses)', { statuses: query.status });
    }
    if (query.toolId) {
      qb.andWhere('intent.toolId = :toolId', { toolId: query.toolId });
    }
    if (query.providerId) {
      qb.andWhere('intent.providerId = :providerId', { providerId: query.providerId });
    }
    if (query.verdict?.length) {
      qb.andWhere('record.verdictStatus IN (:...verdicts)', { verdicts: query.verdict });
    }
    if (query.search) {
      // No dedicated text column on this table. `id` and `requestHash` are the
      // two values a buyer plausibly has in hand (a receipt id copied from a
      // log, a request hash from a dispute) — a documented choice, not the
      // full "receipt number / ULID / tool id / tx reference" global search,
      // which is a separate, cross-resource feature this endpoint does not
      // implement.
      qb.andWhere('(intent.id::text ILIKE :search OR intent.requestHash ILIKE :search)', {
        search: `%${query.search}%`,
      });
    }

    applyTimeWindow(qb, query, TOOL_CALLS_LIST);

    const page = await paginate(qb, query, TOOL_CALLS_LIST);
    const verdicts = await this.verdictsByIntentId(
      organizationId,
      page.items.map((intent) => intent.id),
    );

    return page.map((intent) => this.toDto(intent, verdicts.get(intent.id) ?? null));
  }

  async getOne(organizationId: string, intentId: string): Promise<ToolCallDto> {
    const intent = await this.paymentIntents.findOneBy({ organizationId, id: intentId });
    if (!intent) {
      throw PaymentErrors.paymentIntentNotFound({ id: intentId });
    }

    const record = await this.verificationRecords.findByIntentId(organizationId, intentId);
    return this.toDto(
      intent,
      record?.verdictStatus ? (record.verdictStatus as VerdictStatus) : null,
    );
  }

  /** One batched lookup rather than one query per row — see the class comment. */
  private async verdictsByIntentId(
    organizationId: string,
    intentIds: readonly string[],
  ): Promise<Map<string, VerdictStatus | null>> {
    const map = new Map<string, VerdictStatus | null>();
    if (intentIds.length === 0) return map;

    const records = await this.verificationRecords.find({
      where: { organizationId, intentId: In(intentIds) },
    });
    for (const record of records) {
      map.set(
        record.intentId,
        record.verdictStatus ? (record.verdictStatus as VerdictStatus) : null,
      );
    }
    return map;
  }

  private toDto(intent: PaymentIntentEntity, verdict: VerdictStatus | null): ToolCallDto {
    const asset = intent.assetId as AssetId;
    const listedPrice = MoneyUtil.of(intent.priceAmount, asset, intent.decimals);
    // The same rule as `ReceiptService` (`verification/services/receipt.service.ts`),
    // through the same predicate (`domain/collection.ts`): charged is the
    // listed price once `SETTLED` — unless the provider forfeited it or the
    // debt was written off — zero otherwise. Never `listed - withheld`, so
    // this list and the receipt cannot disagree about the same call (M4).
    const chargedPrice: Money =
      intent.status === PaymentIntentStatus.SETTLED && isChargedWhenSettled(intent)
        ? listedPrice
        : MoneyUtil.zero(asset, intent.decimals);
    const settled = intent.status === PaymentIntentStatus.SETTLED;

    return {
      intentId: intent.id,
      toolId: intent.toolId,
      providerId: intent.providerId,
      status: intent.status as PaymentIntentStatus,
      price: toMoneyDto(listedPrice),
      charged: toMoneyDto(chargedPrice),
      forfeited: settled && collectionStateOf(intent) === CollectionState.PROVIDER_FORFEITED,
      debt: settled ? debtStateOf(intent) : null,
      collectableAt: intent.collectableAt ?? null,
      disputeWindowEndsAt: disputeWindowEndOf(intent.collectableAt),
      verdict,
      createdAt: intent.createdAt,
    };
  }
}

function toMoneyDto(money: Money): ToolCallDto['price'] {
  return { amount: money.amount, asset: money.asset, decimals: money.decimals };
}
