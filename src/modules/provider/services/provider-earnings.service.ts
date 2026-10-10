import { Injectable } from '@nestjs/common';

import {
  CREDITED_SQL,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import { AssetId, isAssetId } from '@modules/chains/ports/caip.types';
import { WITHHELD_STATUSES } from '@modules/ledger/domain/withheld';
import { ApiErrors } from '@shared/api';

import {
  GetProviderEarningsQueryDto,
  GetProviderEarningsResponseDto,
  ProviderEarningsFiguresDto,
  ProviderEarningsGroupBy,
  ProviderEarningsGroupDto,
} from '../dto/get-provider-earnings.dto';
import { ProviderErrors } from '../errors/provider.errors';
import { dayExpr } from './day-bucket.util';

const DAY_EXPR = dayExpr('intent');
const SETTLED_STATUS = 'SETTLED';

interface EarningsRow {
  readonly key: string;
  readonly asset: string;
  readonly decimals: string;
  readonly calls: string;
  readonly earned: string;
  readonly platformFee: string;
  readonly withheld: string;
  readonly withheldCalls: string;
}

interface Figures {
  readonly calls: number;
  readonly earned: bigint;
  readonly platformFee: bigint;
  readonly withheld: bigint;
  readonly withheldCalls: number;
}

const ZERO_FIGURES: Figures = {
  calls: 0,
  earned: 0n,
  platformFee: 0n,
  withheld: 0n,
  withheldCalls: 0,
};

/**
 * `GET /providers/me/earnings`.
 *
 * **Deliberately cross-organization**, exactly like `ProviderTrafficService` —
 * see that class for the full justification. Grouped and aggregated in SQL for
 * the same reason `PaymentIntentRepository.summarizeReceipts` is: a browser
 * (or this process) should not sum thousands of rows by hand.
 */
@Injectable()
export class ProviderEarningsService {
  constructor(private readonly intents: PaymentIntentRepository) {}

  async getEarnings(
    providerId: string,
    query: GetProviderEarningsQueryDto,
  ): Promise<GetProviderEarningsResponseDto> {
    const from = new Date(query.from);
    const to = new Date(query.to);

    if (!(from.getTime() < to.getTime())) {
      throw ProviderErrors.invalidTimeRange({ from: query.from, to: query.to });
    }
    if (query.asset !== undefined && !isAssetId(query.asset)) {
      throw ApiErrors.invalidFilter({ filter: 'asset', value: query.asset });
    }

    const groupExpr = query.groupBy === ProviderEarningsGroupBy.DAY ? DAY_EXPR : 'intent.toolId';

    // Earned means credited: the hold was committed, which is when
    // `PROVIDER_CREDIT` is written (`CREDITED_SQL`). A rail-B call is credited
    // when `redeem_voucher` lands, not when the verdict settles it, and a
    // SETTLED row with no committed hold credited nobody — so the figure
    // matches the earnings ledger.
    const qb = this.intents
      .createQueryBuilder('intent')
      .select(groupExpr, 'key')
      .addSelect('intent.assetId', 'asset')
      .addSelect('intent.decimals', 'decimals')
      .addSelect('COUNT(*)', 'calls')
      .addSelect(
        `COALESCE(SUM(CASE WHEN intent.status = :settledStatus AND ${CREDITED_SQL} ` +
          `THEN intent.providerAmount ELSE 0 END), 0)`,
        'earned',
      )
      .addSelect(
        `COALESCE(SUM(CASE WHEN intent.status = :settledStatus AND ${CREDITED_SQL} ` +
          `THEN intent.platformFee ELSE 0 END), 0)`,
        'platformFee',
      )
      .addSelect(
        `COALESCE(SUM(CASE WHEN intent.status IN (:...withheldStatuses) AND intent.holdId IS NOT NULL ` +
          `THEN intent.providerAmount ELSE 0 END), 0)`,
        'withheld',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE intent.status IN (:...withheldStatuses) AND intent.holdId IS NOT NULL)`,
        'withheldCalls',
      )
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.providerId = :providerId', { providerId })
      .andWhere('intent.createdAt >= :from', { from })
      .andWhere('intent.createdAt < :to', { to })
      .setParameters({ settledStatus: SETTLED_STATUS, withheldStatuses: WITHHELD_STATUSES });

    if (query.asset) {
      qb.andWhere('intent.assetId = :assetId', { assetId: query.asset });
    }

    const rows = await qb
      .groupBy(groupExpr)
      .addGroupBy('intent.assetId')
      .addGroupBy('intent.decimals')
      .getRawMany<EarningsRow>();

    const asset = resolveAsset(rows, query.asset);
    const decimals = asset ? Number(rows.find((r) => r.asset === asset)?.decimals ?? 0) : 0;

    const groups: ProviderEarningsGroupDto[] = rows.map((row) => ({
      key: row.key,
      ...toFiguresDto(toFigures(row), asset, decimals),
    }));

    const totals = rows.reduce<Figures>(
      (total, row) => addFigures(total, toFigures(row)),
      ZERO_FIGURES,
    );

    return {
      groups,
      totals: toFiguresDto(totals, asset, decimals),
      /**
       * `null`, never `''`, when the window earned nothing in no particular
       * asset.
       *
       * An empty string here is a malformed CAIP-19 id wearing the shape of a
       * valid one. A client that renders `asset` into a symbol gets a blank; a
       * client that looks it up in an asset registry gets a miss it has no
       * branch for. `null` says the one true thing — this window has no asset
       * because it has no rows — and forces the caller to handle it.
       */
      asset: asset ?? query.asset ?? null,
    };
  }
}

function resolveAsset(rows: readonly EarningsRow[], requested?: string): AssetId | null {
  if (requested) return requested as AssetId;

  const distinct = [...new Set(rows.map((row) => row.asset))];
  if (distinct.length > 1) {
    throw ProviderErrors.multipleAssets({ assets: distinct.join(', ') });
  }
  return (distinct[0] as AssetId | undefined) ?? null;
}

function toFigures(row: EarningsRow): Figures {
  return {
    calls: Number(row.calls),
    earned: BigInt(row.earned),
    platformFee: BigInt(row.platformFee),
    withheld: BigInt(row.withheld),
    withheldCalls: Number(row.withheldCalls),
  };
}

function addFigures(a: Figures, b: Figures): Figures {
  return {
    calls: a.calls + b.calls,
    earned: a.earned + b.earned,
    platformFee: a.platformFee + b.platformFee,
    withheld: a.withheld + b.withheld,
    withheldCalls: a.withheldCalls + b.withheldCalls,
  };
}

function toFiguresDto(
  figures: Figures,
  asset: AssetId | null,
  decimals: number,
): ProviderEarningsFiguresDto {
  /**
   * A zero in an unknown asset is `null`, not `{ amount: '0', asset: '' }`.
   *
   * `Money` on this surface is a triple, and every consumer is entitled to
   * assume `asset` identifies something. When the window matched no rows there
   * is genuinely no asset to name — the caller did not filter by one and the
   * data did not supply one — so the figure is absent rather than a zero that
   * claims to be denominated in nothing. `MoneyUtil` refuses to operate on such
   * a value anyway, so emitting it only moves the failure to the client.
   */
  const money = (amount: bigint) =>
    asset === null ? null : { amount: amount.toString(), asset, decimals };
  return {
    calls: figures.calls,
    earned: money(figures.earned),
    platformFee: money(figures.platformFee),
    withheld: money(figures.withheld),
    withheldCalls: figures.withheldCalls,
  };
}
