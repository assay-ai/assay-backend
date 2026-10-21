import { Injectable } from '@nestjs/common';

import {
  PaymentIntentRepository,
  ReceiptsSummaryGroupBy,
  ReceiptsSummaryRow,
} from '@database/postgres/repositories/payment-intent.repository';
import {
  FreeCallsSummaryRow,
  ToolCallRecordRepository,
} from '@database/postgres/repositories/tool-call-record.repository';
import { AssetId, isAssetId } from '@modules/chains/ports/caip.types';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';

import {
  DailyReceiptsSummaryResponseDto,
  GetReceiptsSummaryResponseDto,
  ReceiptsSummaryComparison,
  ReceiptsSummaryFigures,
  ReceiptsSummaryGroupDto,
  SignedAmountDto,
  SummaryCompareTo,
  parseSummaryWindow,
} from '../dto/get-receipts-summary.dto';
import { VerificationErrors } from '../errors/verification.errors';

/** The raw figures a group folds to, before either window's numbers become a DTO. */
interface Figures {
  readonly calls: number;
  readonly refundedCalls: number;
  readonly listedTotal: bigint;
  readonly chargedTotal: bigint;
  readonly withheldTotal: bigint;
  readonly notChargedTotal: bigint;
  readonly notChargedCalls: number;
  readonly owedTotal: bigint;
  readonly owedCalls: number;
  readonly inProgressTotal: bigint;
  readonly inProgressCalls: number;
  readonly freeCalls: number;
}

const ZERO_FIGURES: Figures = {
  calls: 0,
  refundedCalls: 0,
  listedTotal: 0n,
  chargedTotal: 0n,
  withheldTotal: 0n,
  notChargedTotal: 0n,
  notChargedCalls: 0,
  owedTotal: 0n,
  owedCalls: 0,
  inProgressTotal: 0n,
  inProgressCalls: 0,
  freeCalls: 0,
};

/**
 * `GET /receipts/summary`.
 *
 * Two requirements: the same endpoint must serve the dashboard, the export
 * and the statement — so the three cannot disagree with each other in front
 * of a finance approver — and every aggregate must reconcile exactly to the
 * sum of its rows. Both are
 * true here by construction rather than by cross-checking: `totals` is
 * computed by summing the exact `Figures` each group was built from — the
 * same bigints, before any DTO ever renders them — so there is no second
 * query and no floating-point step where the two could drift apart.
 *
 * Grouping and the period comparison are both server-side SQL
 * (`PaymentIntentRepository.summarizeReceipts`): a browser cannot fetch
 * 15,000 rows to sum them, and neither does this process.
 */
@Injectable()
export class ReceiptSummaryService {
  constructor(
    private readonly intents: PaymentIntentRepository,
    // Free calls have no payment intent: `freeCalls` reads them here.
    private readonly freeCalls: ToolCallRecordRepository,
  ) {}

  async getSummary(
    organizationId: string,
    query: {
      readonly from: string;
      readonly to: string;
      readonly groupBy: ReceiptsSummaryGroupBy;
      readonly compareTo?: SummaryCompareTo;
      readonly asset?: string;
    },
  ): Promise<GetReceiptsSummaryResponseDto> {
    const window = parseSummaryWindow(query);
    if (!(window.from.getTime() < window.to.getTime())) {
      throw VerificationErrors.summaryInvalidRange({ from: query.from, to: query.to });
    }

    if (query.asset !== undefined && !isAssetId(query.asset)) {
      throw VerificationErrors.summaryInvalidRange({
        from: query.from,
        to: query.to,
        reason: `not a CAIP-19 asset id: ${query.asset}`,
      });
    }

    const paidRows = await this.intents.summarizeReceipts(
      organizationId,
      query.groupBy,
      window,
      query.asset,
    );

    const asset = this.resolveAsset(paidRows, query.asset);
    const currentRows = withFreeCalls(
      paidRows,
      await this.freeCalls.summarizeFreeCalls(organizationId, query.groupBy, window),
      asset,
    );

    const compareRequested = query.compareTo === SummaryCompareTo.PREVIOUS_PERIOD;
    const previousRows = compareRequested
      ? withFreeCalls(
          await this.intents.summarizeReceipts(
            organizationId,
            query.groupBy,
            previousWindow(window),
            asset ?? query.asset,
          ),
          await this.freeCalls.summarizeFreeCalls(
            organizationId,
            query.groupBy,
            previousWindow(window),
          ),
          asset,
        )
      : [];

    return toResponse(currentRows, compareRequested ? previousRows : null, asset, query.asset);
  }

  /**
   * One `getSummary(groupBy)` answer per UTC day of `[from, to)`, from ONE
   * query grouped by day as well (`summarizeReceipts`' `byUtcDay`).
   *
   * Each day is folded by the same `resolveAsset` and `toResponse` a
   * `getSummary` call for that day runs, over the same rows in the same
   * order, so `days[i].summary` is that call's response — a day spanning two
   * assets with no `asset` throws the same error that call would. The window
   * must be whole UTC days: a partial edge day would be a different window from
   * the one a per-day call asks for.
   */
  async getDailySummaries(
    organizationId: string,
    query: {
      readonly from: string;
      readonly to: string;
      readonly groupBy: ReceiptsSummaryGroupBy;
      readonly asset?: string;
    },
  ): Promise<DailyReceiptsSummaryResponseDto> {
    const window = parseSummaryWindow(query);
    const days = utcDaysOf(window);
    if (days === null) {
      throw VerificationErrors.summaryInvalidRange({
        from: query.from,
        to: query.to,
        reason: `a whole number of UTC days, 1 to ${MAX_DAILY_SUMMARY_DAYS}, is required`,
      });
    }

    if (query.asset !== undefined && !isAssetId(query.asset)) {
      throw VerificationErrors.summaryInvalidRange({
        from: query.from,
        to: query.to,
        reason: `not a CAIP-19 asset id: ${query.asset}`,
      });
    }

    const rows = await this.intents.summarizeReceipts(
      organizationId,
      query.groupBy,
      window,
      query.asset,
      { byUtcDay: true },
    );

    const free = await this.freeCalls.summarizeFreeCalls(organizationId, query.groupBy, window, {
      byUtcDay: true,
    });

    return {
      days: days.map((day) => {
        const paidRows = rows.filter((row) => row.day === day.key);
        const asset = this.resolveAsset(paidRows, query.asset);
        const dayRows = withFreeCalls(
          paidRows,
          free.filter((row) => row.day === day.key),
          asset,
        );
        return { ...day, summary: toResponse(dayRows, null, asset, query.asset) };
      }),
    };
  }

  /**
   * The single asset every total in the response is denominated in.
   *
   * A `Money` sum across assets is not a number — `MoneyUtil.sum` refuses it —
   * so a window whose rows span more than one asset with no `?asset=` filter
   * is refused loudly rather than silently mixed. An explicit filter always
   * wins, even against an empty result set, so a caller checking a specific
   * asset gets a well-typed zero response rather than an unresolvable one.
   */
  private resolveAsset(rows: readonly ReceiptsSummaryRow[], requested?: string): AssetId | null {
    if (requested) {
      return requested as AssetId;
    }

    const distinct = [...new Set(rows.map((row) => row.asset))];
    if (distinct.length > 1) {
      throw VerificationErrors.summaryMultipleAssets({ assets: distinct.join(', ') });
    }
    return (distinct[0] as AssetId | undefined) ?? null;
  }
}

/** The longest window `getDailySummaries` answers: a month of days. */
export const MAX_DAILY_SUMMARY_DAYS = 31;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The UTC days of a window that starts and ends on UTC midnights, oldest
 * first, or `null` when it does not, is empty, or is longer than
 * {@link MAX_DAILY_SUMMARY_DAYS}.
 */
function utcDaysOf(window: { readonly from: Date; readonly to: Date }): DailyWindow[] | null {
  const from = window.from.getTime();
  const to = window.to.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (from % DAY_MS !== 0 || to % DAY_MS !== 0) return null;
  const count = (to - from) / DAY_MS;
  if (count < 1 || count > MAX_DAILY_SUMMARY_DAYS) return null;
  return Array.from({ length: count }, (_, i) => {
    const start = new Date(from + i * DAY_MS);
    return {
      key: start.toISOString().slice(0, 10),
      from: start.toISOString(),
      to: new Date(start.getTime() + DAY_MS).toISOString(),
    };
  });
}

interface DailyWindow {
  readonly key: string;
  readonly from: string;
  readonly to: string;
}

/**
 * The response for one window's rows, and the previous window's when a
 * comparison was asked for (`null` when not). `getSummary` and every day of
 * `getDailySummaries` end here, so the two cannot fold a row differently.
 */
function toResponse(
  currentRows: readonly ReceiptsSummaryRow[],
  previousRows: readonly ReceiptsSummaryRow[] | null,
  asset: AssetId | null,
  requestedAsset: string | undefined,
): GetReceiptsSummaryResponseDto {
  const decimals = asset ? getAssetMetadata(asset).decimals : 0;
  const previousByKey = new Map((previousRows ?? []).map((row) => [row.key, toFigures(row)]));

  const groups: ReceiptsSummaryGroupDto[] = currentRows.map((row) => {
    const figures = toFigures(row);
    const comparison = previousRows
      ? toComparisonDto(figures, previousByKey.get(row.key) ?? ZERO_FIGURES, asset, decimals)
      : null;

    return { key: row.key, ...toFiguresDto(figures, asset, decimals), comparison };
  });

  const totals = currentRows.reduce<Figures>(
    (total, row) => addFigures(total, toFigures(row)),
    ZERO_FIGURES,
  );

  return {
    groups,
    totals: toFiguresDto(totals, asset, decimals),
    asset: asset ?? requestedAsset ?? '',
  };
}

/**
 * The paid rows with the window's free calls added to `freeCalls` (BUG-AGT-01).
 * A free call has no payment intent, so it is in no other figure: not in
 * `calls`, which counts the calls behind the money, nor in any amount. A key
 * with free calls only becomes a group of its own, all zero but `freeCalls`, so
 * `totals` stays the sum of `groups`. Rows stay in key order.
 */
function withFreeCalls(
  rows: readonly ReceiptsSummaryRow[],
  free: readonly FreeCallsSummaryRow[],
  asset: AssetId | null,
): ReceiptsSummaryRow[] {
  if (free.length === 0) return [...rows];
  const byKey = new Map<string, number>();
  for (const row of free) byKey.set(row.key, (byKey.get(row.key) ?? 0) + row.freeCalls);

  const merged = rows.map((row) => {
    const count = byKey.get(row.key);
    if (count === undefined) return row;
    byKey.delete(row.key);
    return { ...row, freeCalls: row.freeCalls + count };
  });
  if (byKey.size === 0) return merged;

  const decimals = asset ? getAssetMetadata(asset).decimals : 0;
  const added = [...byKey].map(
    ([key, count]): ReceiptsSummaryRow => ({
      key,
      asset: asset ?? '',
      decimals,
      ...ZERO_FIGURES,
      freeCalls: count,
    }),
  );
  return [...merged, ...added].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The immediately preceding window of the same length. */
function previousWindow(window: { readonly from: Date; readonly to: Date }): {
  from: Date;
  to: Date;
} {
  const length = window.to.getTime() - window.from.getTime();
  return { from: new Date(window.from.getTime() - length), to: window.from };
}

function toFigures(row: ReceiptsSummaryRow): Figures {
  return {
    calls: row.calls,
    refundedCalls: row.refundedCalls,
    listedTotal: row.listedTotal,
    chargedTotal: row.chargedTotal,
    withheldTotal: row.withheldTotal,
    notChargedTotal: row.notChargedTotal,
    notChargedCalls: row.notChargedCalls,
    owedTotal: row.owedTotal,
    owedCalls: row.owedCalls,
    inProgressTotal: row.inProgressTotal,
    inProgressCalls: row.inProgressCalls,
    freeCalls: row.freeCalls,
  };
}

function addFigures(a: Figures, b: Figures): Figures {
  return {
    calls: a.calls + b.calls,
    refundedCalls: a.refundedCalls + b.refundedCalls,
    listedTotal: a.listedTotal + b.listedTotal,
    chargedTotal: a.chargedTotal + b.chargedTotal,
    withheldTotal: a.withheldTotal + b.withheldTotal,
    notChargedTotal: a.notChargedTotal + b.notChargedTotal,
    notChargedCalls: a.notChargedCalls + b.notChargedCalls,
    owedTotal: a.owedTotal + b.owedTotal,
    owedCalls: a.owedCalls + b.owedCalls,
    inProgressTotal: a.inProgressTotal + b.inProgressTotal,
    inProgressCalls: a.inProgressCalls + b.inProgressCalls,
    freeCalls: a.freeCalls + b.freeCalls,
  };
}

function toFiguresDto(
  figures: Figures,
  asset: AssetId | null,
  decimals: number,
): ReceiptsSummaryFigures {
  const money = (amount: bigint) => moneyDto(amount, asset, decimals);
  return {
    calls: figures.calls,
    // Published beside the rate so a reader can check the division rather than
    // take it on trust — the same reason `withheld` never ships without its
    // call count.
    refundedCalls: figures.refundedCalls,
    listedTotal: money(figures.listedTotal),
    chargedTotal: money(figures.chargedTotal),
    withheldTotal: money(figures.withheldTotal),
    notChargedTotal: money(figures.notChargedTotal),
    notChargedCalls: figures.notChargedCalls,
    owedTotal: money(figures.owedTotal),
    owedCalls: figures.owedCalls,
    inProgressTotal: money(figures.inProgressTotal),
    inProgressCalls: figures.inProgressCalls,
    freeCalls: figures.freeCalls,
    failRate: figures.calls === 0 ? null : figures.refundedCalls / figures.calls,
  };
}

function toComparisonDto(
  current: Figures,
  previous: Figures,
  asset: AssetId | null,
  decimals: number,
): ReceiptsSummaryComparison {
  const signed = (amount: bigint) => signedDto(amount, asset, decimals);
  return {
    ...toFiguresDto(previous, asset, decimals),
    deltaCalls: current.calls - previous.calls,
    deltaListedTotal: signed(current.listedTotal - previous.listedTotal),
    deltaChargedTotal: signed(current.chargedTotal - previous.chargedTotal),
    deltaWithheldTotal: signed(current.withheldTotal - previous.withheldTotal),
    deltaNotChargedTotal: signed(current.notChargedTotal - previous.notChargedTotal),
    deltaOwedTotal: signed(current.owedTotal - previous.owedTotal),
  };
}

/**
 * A total is always non-negative by construction (a `SUM` of non-negative
 * `price_amount` rows), so this never needs `MoneyUtil`'s range check — and
 * cannot always route through it anyway, since an empty result with no
 * `?asset=` filter has no asset to construct a `Money` against.
 */
function moneyDto(amount: bigint, asset: AssetId | null, decimals: number) {
  return { amount: amount.toString(), asset: asset ?? '', decimals };
}

/** A delta, which may be negative — deliberately not `Money` (`MoneyUtil` refuses negative amounts). */
function signedDto(amount: bigint, asset: AssetId | null, decimals: number): SignedAmountDto {
  return { amount: amount.toString(), asset: asset ?? '', decimals };
}
