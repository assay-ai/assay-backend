import {
  DISPUTE_FILING_GUARD_SECONDS,
  disputeWindowEndOf,
} from '../constants/collection-hold.constants';
import { Injectable, Optional } from '@nestjs/common';
import { In, SelectQueryBuilder } from 'typeorm';

import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { ToolCallRecordEntity } from '@database/postgres/entities/tool-call-record.entity';
import { VerificationRecordEntity } from '@database/postgres/entities/verification-record.entity';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { ToolCallRecordRepository } from '@database/postgres/repositories/tool-call-record.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { isWithheldIntent } from '@modules/ledger/domain/withheld';
import { VerdictStatus } from '@modules/verification/domain/verdict';
import {
  ApiErrors,
  CursorPageDto,
  ListSpec,
  applyTimeWindow,
  asExactNumber,
  asInstant,
  fetchKeysetRows,
  mergeKeysetPages,
  paginate,
  resolveSort,
} from '@shared/api';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  CollectionState,
  collectionStateOf,
  debtStateOf,
  isChargedWhenSettled,
  isNotCollected,
  isRefundedByReport,
} from '../domain/collection';
import {
  FreeToolCallDto,
  ListToolCallsQueryDto,
  PaidToolCallRowDto,
  ToolCallDto,
  ToolCallListItemDto,
} from '../dto/list-tool-calls.dto';
import { PaymentErrors } from '../errors/payment.errors';
import { PaymentIntentStatus, PaymentRail } from '../ports/payment.types';
import { containsLikePattern } from '@shared/utils/like-pattern.util';

/**
 * For a page of calls: whether a report filed now on each would be refunded
 * in full, until when, and whether one is already open on it.
 * `RefundEligibilityService.ofCalls` (dispute module), passed in by the
 * controller so this module does not import the dispute module that imports
 * it.
 */
export type RefundableCheck = (
  calls: readonly { intent: PaymentIntentEntity; settledAt: Date | null }[],
  now: Date,
) => Promise<
  ReadonlyMap<
    string,
    { readonly refundable: boolean; readonly until: Date | null; readonly reported: boolean }
  >
>;

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
 * The served free calls (`tool_call_records`, BUG-AGT-01), for
 * `GET /tool-calls?include=free`. `createdAt` only: a free call has no price,
 * and the cursor stamp (`createdAt:<dir>`) is the paid list's, so one cursor
 * names one position in both lists.
 */
const FREE_CALLS_LIST: ListSpec = {
  alias: 'call',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'call.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: ToolCallRecordEntity) => row.createdAt),
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
    // `include=free` only. Optional so the older direct constructions keep
    // compiling; a request for free rows without it fails loudly.
    @Optional() private readonly freeCalls: ToolCallRecordRepository | null = null,
  ) {}

  /**
   * `GET /tool-calls`. Without `include=free` this is exactly the paid list it
   * always was. With it (BUG-AGT-01), the served free calls are merged in by
   * `createdAt` under one cursor and every item carries `kind`.
   */
  async list(
    organizationId: string,
    query: ListToolCallsQueryDto & { include?: undefined; kind?: undefined },
    refundableCheck?: RefundableCheck,
  ): Promise<CursorPageDto<ToolCallDto>>;
  async list(
    organizationId: string,
    query: ListToolCallsQueryDto,
    refundableCheck?: RefundableCheck,
  ): Promise<CursorPageDto<ToolCallListItemDto>>;
  async list(
    organizationId: string,
    query: ListToolCallsQueryDto,
    refundableCheck?: RefundableCheck,
  ): Promise<CursorPageDto<ToolCallListItemDto>> {
    if (query.kind !== undefined && query.include !== 'free') {
      throw ApiErrors.invalidFilter({
        filter: 'kind',
        value: query.kind,
        allowed: ['include=free'],
      });
    }
    if (query.include !== 'free') {
      return this.listPaid(organizationId, query, refundableCheck);
    }

    const sort = resolveSort(query, TOOL_CALLS_LIST);
    if (sort.key !== 'createdAt') {
      throw ApiErrors.unknownSortField({ field: sort.key, allowed: ['createdAt'] });
    }
    // A free call has no payment status and is never refundable.
    const withFree = query.kind !== 'paid' && !query.status?.length && !query.refundable;
    if (!withFree) {
      const page = await this.listPaid(organizationId, query, refundableCheck);
      return page.map((row): PaidToolCallRowDto => ({ ...row, kind: 'paid' }));
    }
    if (query.kind === 'free') {
      const page = await paginate(this.freeQuery(organizationId, query), query, FREE_CALLS_LIST);
      return page.map(toFreeDto);
    }
    return this.listMerged(organizationId, query);
  }

  /**
   * Paid and free rows under one cursor: each source fetched with the same
   * keyset bound and `limit + 1`, merged by `(createdAt, id)` at microsecond
   * precision, and the first `limit` kept. If either source had more, the
   * merged list does too, so `hasMore` is never wrong.
   */
  private async listMerged(
    organizationId: string,
    query: ListToolCallsQueryDto,
  ): Promise<CursorPageDto<ToolCallListItemDto>> {
    const [paid, free] = await Promise.all([
      fetchKeysetRows(this.paidQuery(organizationId, query, new Date()), query, TOOL_CALLS_LIST),
      fetchKeysetRows(this.freeQuery(organizationId, query), query, FREE_CALLS_LIST),
    ]);
    type Merged =
      | { readonly id: string; readonly at: string; readonly paid: PaymentIntentEntity }
      | { readonly id: string; readonly at: string; readonly free: ToolCallRecordEntity };
    const page = mergeKeysetPages<Merged>(
      [
        {
          rows: paid.rows.map((row) => ({ id: row.id, at: paid.sortValueOf(row), paid: row })),
          sortValueOf: (row) => row.at,
        },
        {
          rows: free.rows.map((row) => ({ id: row.id, at: free.sortValueOf(row), free: row })),
          sortValueOf: (row) => row.at,
        },
      ],
      query,
      TOOL_CALLS_LIST,
    );
    const records = await this.recordsByIntentId(
      organizationId,
      page.items.flatMap((item) => ('paid' in item ? [item.id] : [])),
    );
    return page.map((item): ToolCallListItemDto => {
      if (!('paid' in item)) return toFreeDto(item.free);
      const status = records.get(item.id)?.verdictStatus;
      return {
        ...this.toDto(item.paid, status ? (status as VerdictStatus) : null),
        kind: 'paid',
      };
    });
  }

  /**
   * The served free calls: a free or freemium call that reached a provider
   * (`refusal_code IS NULL`), with the filters that mean something for it.
   */
  private freeQuery(
    organizationId: string,
    query: ListToolCallsQueryDto,
  ): SelectQueryBuilder<ToolCallRecordEntity> {
    if (!this.freeCalls) {
      throw new Error('include=free needs the tool-call record repository');
    }
    const qb = this.freeCalls
      .createQueryBuilder('call')
      .where('call.organizationId = :organizationId', { organizationId })
      .andWhere('call.pricingMode IS NOT NULL')
      .andWhere('call.refusalCode IS NULL');
    if (query.toolId) qb.andWhere('call.toolId = :toolId', { toolId: query.toolId });
    if (query.providerId) {
      qb.andWhere('call.providerId = :providerId', { providerId: query.providerId });
    }
    if (query.verdict?.length) {
      qb.andWhere('call.verdict IN (:...verdicts)', { verdicts: query.verdict });
    }
    if (query.search) {
      qb.andWhere('(call.callId::text ILIKE :search OR call.requestHash ILIKE :search)', {
        search: containsLikePattern(query.search),
      });
    }
    applyTimeWindow(qb, query, FREE_CALLS_LIST);
    return qb;
  }

  /**
   * The paid list: `payment_intents`, exactly as it always was (the list
   * without `include=free`, and the dashboard overview's recent calls).
   */
  async listPaid(
    organizationId: string,
    query: ListToolCallsQueryDto,
    refundableCheck?: RefundableCheck,
  ): Promise<CursorPageDto<ToolCallDto>> {
    if (query.refundable && !refundableCheck) {
      // Never answer "nothing refundable" for want of the check.
      throw new Error('refundable=true needs the refund eligibility check');
    }
    const now = new Date();
    const qb = this.paidQuery(organizationId, query, now);
    const page = await paginate(qb, query, TOOL_CALLS_LIST);
    const records = await this.recordsByIntentId(
      organizationId,
      page.items.map((intent) => intent.id),
    );
    const verdictOf = (intentId: string): VerdictStatus | null => {
      const status = records.get(intentId)?.verdictStatus;
      return status ? (status as VerdictStatus) : null;
    };

    if (!query.refundable || !refundableCheck) {
      return page.map((intent) => this.toDto(intent, verdictOf(intent.id)));
    }

    // The same answer the receipt gives, for the page at once. A row that no
    // longer qualifies, or already carries an open report (it cannot be
    // reported again), is dropped from the page; the cursor is unaffected.
    const checked = await refundableCheck(
      page.items.map((intent) => ({
        intent,
        settledAt: records.get(intent.id)?.settledAt ?? null,
      })),
      now,
    );
    const answers = new Map<string, Date | null>();
    for (const intent of page.items) {
      const answer = checked.get(intent.id);
      if (answer?.refundable && !answer.reported) answers.set(intent.id, answer.until);
    }
    return new CursorPageDto(
      page.items
        .filter((intent) => answers.has(intent.id))
        .map((intent) => ({
          ...this.toDto(intent, verdictOf(intent.id)),
          refundableIfReportedUntil: answers.get(intent.id) ?? null,
        })),
      page.pageInfo.nextCursor,
    );
  }

  /** The paid rows' query, every filter applied; ordering and the bound are the caller's. */
  private paidQuery(
    organizationId: string,
    query: ListToolCallsQueryDto,
    now: Date,
  ): SelectQueryBuilder<PaymentIntentEntity> {
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
        search: containsLikePattern(query.search),
      });
    }

    if (query.refundable) {
      // Narrows the scan to rows `refundGuaranteedIfReported` could accept; the
      // per-row check below is what decides, so this can only drop rows the
      // predicate would refuse anyway.
      qb.andWhere('intent.status = :settled', { settled: PaymentIntentStatus.SETTLED })
        .andWhere('intent.holdId IS NOT NULL')
        .andWhere('intent.holdReleasedAt IS NULL')
        .andWhere('intent.disputeOutcome IS NULL')
        .andWhere(
          '((intent.heldStatus = :held AND intent.collectableAt > :guardedNow) OR ' +
            '(intent.heldStatus IS NULL AND intent.rail = :railB ' +
            'AND intent.redemptionLapsedAt IS NULL AND intent.redemptionLastError IS NULL))',
          {
            held: 'HELD',
            guardedNow: new Date(now.getTime() + DISPUTE_FILING_GUARD_SECONDS * 1000),
            railB: PaymentRail.RAIL_B_VOUCHER,
          },
        );
    }

    applyTimeWindow(qb, query, TOOL_CALLS_LIST);
    return qb;
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
  private async recordsByIntentId(
    organizationId: string,
    intentIds: readonly string[],
  ): Promise<Map<string, VerificationRecordEntity>> {
    const map = new Map<string, VerificationRecordEntity>();
    if (intentIds.length === 0) return map;

    const records = await this.verificationRecords.find({
      where: { organizationId, intentId: In(intentIds) },
    });
    for (const record of records) map.set(record.intentId, record);
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
      // The receipt's own figure (`ReceiptService`), so a list row, its
      // receipt and `GET /withheld` agree: zero for a call that never reserved
      // anything, such as an unfunded call that expired (BUG-BUY-SPEND-01).
      withheld: toMoneyDto(
        isWithheldIntent({
          status: intent.status,
          holdId: intent.holdId ?? null,
          notCollected: isNotCollected(intent),
        })
          ? listedPrice
          : MoneyUtil.zero(asset, intent.decimals),
      ),
      forfeited: settled && collectionStateOf(intent) === CollectionState.PROVIDER_FORFEITED,
      debt: settled ? debtStateOf(intent) : null,
      refundedByReport: settled && isRefundedByReport(intent),
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

function toFreeDto(call: ToolCallRecordEntity): FreeToolCallDto {
  return {
    kind: 'free',
    intentId: null,
    callId: call.callId,
    toolId: call.toolId,
    toolName: call.toolName ?? null,
    providerId: call.providerId,
    pricingMode: call.pricingMode as string,
    verdict: call.verdict ?? null,
    createdAt: call.createdAt,
  };
}
