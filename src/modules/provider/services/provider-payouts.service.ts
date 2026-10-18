import { Injectable } from '@nestjs/common';

import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { LEGACY_POOLED_VAULT_TX_REF, LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { PLATFORM_ABSORBED_TX_REF_PREFIX } from '@modules/payment/services/voucher-redemption.service';
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
 * Positions are `(exact instant, id)`, compared as `(timestamptz, text)` in both
 * queries so a batch and a redemption order against each other.
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
 * transaction's ref. Not one of the book-only refs — a legacy platform absorb
 * (nobody paid it) or a rail-A credit (paid later, in a `PAYOUT` batch).
 * `starts_with`, not `LIKE`: the `_` in the prefix is not a wildcard.
 */
const REDEMPTION_CREDIT_SQL =
  `entry.entryType = :creditType AND entry.chainTxRef IS NOT NULL ` +
  `AND NOT starts_with(entry.chainTxRef, :absorbedPrefix) AND entry.chainTxRef <> :legacyRef`;

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
  readonly batchId: string | null;
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
 * `GET /providers/me/payouts`: every payment sent to the provider's wallet.
 *
 * Two kinds, newest first in one list (D18):
 *
 * - **BATCH** — a `PAYOUT` ledger entry of a payout run (rail A).
 * - **REDEMPTION** — a rail-B redemption: the buyer's escrow paid the provider
 *   on chain when a voucher was redeemed. Its `PROVIDER_CREDIT` entries are
 *   grouped by transaction, so a transaction that redeemed several calls is
 *   one payment with its call count. Before this, a rail-B provider with money
 *   in its wallet read "No payments yet" (UX review 2026-10-18, D-P0-2).
 *
 * **Not** cross-organization: both kinds are entries on the provider's own
 * ledger, under its own `organization_id`.
 *
 * Paged by keyset over `(createdAt, id)`: each kind is read from its own
 * position with `limit + 1` rows, and the two are merged here, so a page never
 * returns more than twice its size.
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

    const batches = this.ledgerEntries
      .createQueryBuilder('entry')
      .select('entry.id::text', 'id')
      .addSelect(`'${ProviderPaymentKind.BATCH}'`, 'kind')
      .addSelect('entry.batchId', 'batchId')
      .addSelect('entry.amount', 'amount')
      .addSelect('entry.assetId', 'asset')
      .addSelect('entry.decimals', 'decimals')
      .addSelect('entry.chainTxRef', 'chainTxRef')
      .addSelect(
        '(SELECT payout.call_count FROM provider_payouts payout ' +
          'WHERE payout.ledger_entry_id = entry.id ' +
          'AND payout.organization_id = entry.organization_id LIMIT 1)',
        'calls',
      )
      .addSelect('entry.createdAt', 'createdAt')
      .addSelect(exactInstantSql('entry.created_at'), 'at')
      .where('entry.organizationId = :organizationId', { organizationId })
      .andWhere('entry.entryType = :entryType', { entryType: LedgerEntryType.PAYOUT })
      .andWhere('entry.batchId IS NOT NULL');
    if (query.from) batches.andWhere('entry.createdAt >= :from', { from: query.from });
    if (query.to) batches.andWhere('entry.createdAt < :to', { to: query.to });
    if (after) {
      batches.andWhere(
        `(entry.createdAt, entry.id::text) ${comparator} (:afterAt::timestamptz, :afterId)`,
        { afterAt: after.at, afterId: after.id },
      );
    }
    batches.orderBy('entry.createdAt', order).addOrderBy('entry.id::text', order).limit(take);

    // One row per transaction. Its id is the lowest entry id in it: stable,
    // and a uuid like a batch's, so the two kinds share one cursor.
    const groupAt = 'MIN(entry.createdAt)';
    const groupId = 'MIN(entry.id::text)';
    const redemptions = this.ledgerEntries
      .createQueryBuilder('entry')
      .select(groupId, 'id')
      .addSelect(`'${ProviderPaymentKind.REDEMPTION}'`, 'kind')
      .addSelect('NULL', 'batchId')
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
        absorbedPrefix: PLATFORM_ABSORBED_TX_REF_PREFIX,
        legacyRef: LEGACY_POOLED_VAULT_TX_REF,
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

    const [batchRows, redemptionRows] = await Promise.all([
      batches.getRawMany<PaymentRow>(),
      redemptions.getRawMany<PaymentRow>(),
    ]);

    const merged = [...batchRows, ...redemptionRows]
      .sort((a, b) => comparePosition(a, b) * (descending ? -1 : 1))
      .slice(0, take);

    const hasMore = merged.length > query.limit;
    const items = hasMore ? merged.slice(0, query.limit) : merged;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last ? encodeCompositeCursor([last.at], last.id, sort.spec) : null;
    return new CursorPageDto(items.map(toPayoutDto), nextCursor);
  }
}

/** Ascending `(at, id)`: the in-memory twin of both queries' `ORDER BY`. */
function comparePosition(a: PaymentRow, b: PaymentRow): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
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
    batchId: row.batchId,
    amount: { amount: String(row.amount), asset: row.asset, decimals: Number(row.decimals) },
    chainTxRef: row.chainTxRef,
    calls: row.calls === null || row.calls === undefined ? null : Number(row.calls),
    createdAt: new Date(row.createdAt),
  };
}
