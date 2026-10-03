import { Injectable } from '@nestjs/common';

import {
  PaymentIntentRepository,
  ReceiptsSummaryGroupBy,
  ReceiptsSummaryRow,
} from '@database/postgres/repositories/payment-intent.repository';
import { AssetId, isAssetId } from '@modules/chains/ports/caip.types';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';

import {
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
}

const ZERO_FIGURES: Figures = {
  calls: 0,
  refundedCalls: 0,
  listedTotal: 0n,
  chargedTotal: 0n,
  withheldTotal: 0n,
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
  constructor(private readonly intents: PaymentIntentRepository) {}

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

    const currentRows = await this.intents.summarizeReceipts(
      organizationId,
      query.groupBy,
      window,
      query.asset,
    );

    const asset = this.resolveAsset(currentRows, query.asset);
    const decimals = asset ? getAssetMetadata(asset).decimals : 0;

    const compareRequested = query.compareTo === SummaryCompareTo.PREVIOUS_PERIOD;
    const previousRows = compareRequested
      ? await this.intents.summarizeReceipts(
          organizationId,
          query.groupBy,
          previousWindow(window),
          asset ?? query.asset,
        )
      : [];

    const previousByKey = new Map(previousRows.map((row) => [row.key, toFigures(row)]));

    const groups: ReceiptsSummaryGroupDto[] = currentRows.map((row) => {
      const figures = toFigures(row);
      const comparison = compareRequested
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
      asset: asset ?? query.asset ?? '',
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
  };
}

function addFigures(a: Figures, b: Figures): Figures {
  return {
    calls: a.calls + b.calls,
    refundedCalls: a.refundedCalls + b.refundedCalls,
    listedTotal: a.listedTotal + b.listedTotal,
    chargedTotal: a.chargedTotal + b.chargedTotal,
    withheldTotal: a.withheldTotal + b.withheldTotal,
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
