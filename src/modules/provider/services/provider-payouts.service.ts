import { Injectable } from '@nestjs/common';

import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { RAIL_A_BOOK_CREDIT_TX_REF, LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import {
  ApiErrors,
  CursorPageDto,
  ListSpec,
  SortDirection,
  asInstant,
  decodeCompositeCursor,
  encodeCompositeCursor,
  exactInstantSql,
  resolveSort,
} from '@shared/api';

import {
  ListProviderPayoutsQueryDto,
  ProviderPaymentKind,
  ProviderPayoutDto,
} from '../dto/get-provider-payouts.dto';

/**
 * The one sort this list offers: when the money was sent. Resolved through
 * `resolveSort` so an unknown `?sort=` is refused like on every other list.
 * Positions are `(exact instant, id)`, compared as `(timestamptz, text)`.
 */
const PROVIDER_PAYOUT_LIST: ListSpec = {
  alias: 'entry',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'entry.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: { createdAt: Date }) => row.createdAt),
    },
  },
};

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A `PROVIDER_CREDIT` that a redemption transaction paid: it carries the
 * transaction's ref. Not a rail-A credit, whose book-only ref names no
 * transaction of its own.
 */
const REDEMPTION_CREDIT_SQL =
  `entry.entryType = :creditType AND entry.chainTxRef IS NOT NULL ` +
  `AND entry.chainTxRef <> :railARef`;

/**
 * Refs the redemption paths write when no transaction signature was observed:
 * `unobserved:seq=…` (`VoucherRedemptionService`) and `held_collected:seq=…`
 * (a held collect with no tx ref). The seq is per PAYER, so two buyers'
 * redemptions can share one — such a credit is never grouped with another and
 * never named as a transaction.
 */
const SYNTHETIC_REF_SQL =
  `(starts_with(entry.chainTxRef, :unobservedPrefix) ` +
  `OR starts_with(entry.chainTxRef, :heldCollectedPrefix))`;
const SYNTHETIC_REF_PARAMS = {
  unobservedPrefix: 'unobserved:',
  heldCollectedPrefix: 'held_collected:',
};

/** One payment: a real transaction's credits, or one credit with a synthetic ref. */
const PAYMENT_KEY_SQL = `CASE WHEN ${SYNTHETIC_REF_SQL} THEN entry.id::text ELSE entry.chainTxRef END`;

interface PaymentRow {
  readonly id: string;
  readonly kind: ProviderPaymentKind;
  readonly amount: string;
  readonly asset: string;
  readonly decimals: string | number;
  readonly chainTxRef: string | null;
  readonly calls: string | number | null;
  readonly createdAt: Date | string;
  /** `createdAt` at full microsecond precision, for the cursor. */
  readonly at: string;
}

/**
 * `GET /providers/me/payouts`: every payment sent to the provider's wallet —
 * each a rail-B redemption, newest first (D18). The buyer's escrow paid the
 * provider on chain when a voucher was redeemed; its `PROVIDER_CREDIT` entries
 * are grouped by transaction, so a transaction that redeemed several calls is
 * one payment with its call count.
 *
 * **Not** cross-organization: the entries are on the provider's own ledger,
 * under its own `organization_id`.
 *
 * Paged by keyset over `(createdAt, id)` with `limit + 1` rows.
 *
 * A redemption is positioned (and windowed by `from`/`to`) at its FIRST
 * credit, `(MIN(created_at), MIN(id))`. A transaction that redeemed several
 * calls writes its credits one per intent, so a page read mid-way sees part of
 * it; its first credit never moves, so its position stays put and the rest of
 * the calls simply join the row on the next read.
 *
 * Cost: the redemption query groups the provider's whole credit history in
 * the window on every page (filters on the group run in `HAVING`). A per-entry
 * pre-filter on the cursor instant would cut a transaction that straddles it
 * into a partial row, so there is none; `from` narrows the scan correctly only
 * in `HAVING` too. Linear in paid calls, fine at current volume.
 */
@Injectable()
export class ProviderPayoutsService {
  constructor(private readonly ledgerEntries: LedgerEntryRepository) {}

  async listPayouts(
    organizationId: string,
    query: ListProviderPayoutsQueryDto,
  ): Promise<CursorPageDto<ProviderPayoutDto>> {
    const sort = resolveSort(query, PROVIDER_PAYOUT_LIST);
    const descending = sort.direction === SortDirection.DESC;
    const after = query.cursor ? decodePosition(query.cursor, sort.spec) : null;
    const comparator = descending ? '<' : '>';
    const order = descending ? 'DESC' : 'ASC';
    const take = query.limit + 1;
    if (query.from && query.to && query.from >= query.to) {
      throw ApiErrors.invalidTimeRange({
        from: query.from.toISOString(),
        to: query.to.toISOString(),
      });
    }

    // One row per transaction. Its id is the lowest entry id in it: stable,
    // and a uuid, so it can carry the cursor.
    const groupAt = 'MIN(entry.createdAt)';
    const groupId = 'MIN(entry.id::text)';
    const redemptions = this.ledgerEntries
      .createQueryBuilder('entry')
      .select(groupId, 'id')
      .addSelect(`'${ProviderPaymentKind.REDEMPTION}'`, 'kind')
      .addSelect('SUM(entry.amount)', 'amount')
      .addSelect('entry.assetId', 'asset')
      .addSelect('entry.decimals', 'decimals')
      // A synthetic ref names no transaction: it is not shown as one.
      .addSelect(
        `CASE WHEN bool_or(${SYNTHETIC_REF_SQL}) THEN NULL ELSE MIN(entry.chainTxRef) END`,
        'chainTxRef',
      )
      .addSelect('COUNT(*)', 'calls')
      .addSelect(groupAt, 'createdAt')
      .addSelect(exactInstantSql('MIN(entry.created_at)'), 'at')
      .where('entry.organizationId = :organizationId', { organizationId })
      .andWhere(REDEMPTION_CREDIT_SQL, {
        creditType: LedgerEntryType.PROVIDER_CREDIT,
        railARef: RAIL_A_BOOK_CREDIT_TX_REF,
      })
      .setParameters(SYNTHETIC_REF_PARAMS)
      .groupBy(PAYMENT_KEY_SQL)
      .addGroupBy('entry.assetId')
      .addGroupBy('entry.decimals');
    const having: string[] = [];
    const havingParams: Record<string, unknown> = {};
    if (query.from) {
      having.push(`${groupAt} >= :from`);
      havingParams.from = query.from;
    }
    if (query.to) {
      having.push(`${groupAt} < :to`);
      havingParams.to = query.to;
    }
    if (after) {
      having.push(`(${groupAt}, ${groupId}) ${comparator} (:afterAt::timestamptz, :afterId)`);
      Object.assign(havingParams, { afterAt: after.at, afterId: after.id });
    }
    if (having.length > 0) redemptions.having(having.join(' AND '), havingParams);
    redemptions.orderBy(groupAt, order).addOrderBy(groupId, order).limit(take);

    const rows = await redemptions.getRawMany<PaymentRow>();

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last ? encodeCompositeCursor([last.at], last.id, sort.spec) : null;
    return new CursorPageDto(items.map(toPayoutDto), nextCursor);
  }
}

/** A cursor back into `(at, id)`, each part checked: Postgres casts them, so a bad one is a 400 here. */
function decodePosition(cursor: string, sort: string): { at: string; id: string } {
  const {
    parts: [at],
    id,
  } = decodeCompositeCursor(cursor, sort, 1);
  if (!INSTANT.test(at) || !UUID.test(id)) {
    throw ApiErrors.invalidCursor({ detail: 'malformed position' });
  }
  return { at, id };
}

function toPayoutDto(row: PaymentRow): ProviderPayoutDto {
  return {
    id: row.id,
    kind: row.kind,
    amount: { amount: String(row.amount), asset: row.asset, decimals: Number(row.decimals) },
    chainTxRef: row.chainTxRef,
    calls: row.calls === null || row.calls === undefined ? null : Number(row.calls),
    createdAt: new Date(row.createdAt),
  };
}
