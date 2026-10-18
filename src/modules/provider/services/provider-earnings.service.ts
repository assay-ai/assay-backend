import { Injectable } from '@nestjs/common';

import {
  AWAITING_REDEMPTION_SQL,
  CREDITED_SQL,
  DEBT_OUTSTANDING_SQL,
  FORFEITED_SQL,
  PLATFORM_ABSORBED_SQL,
  PaymentIntentRepository,
  VOIDED_SQL,
  WRITTEN_OFF_SQL,
} from '@database/postgres/repositories/payment-intent.repository';
import { AssetId, isAssetId } from '@modules/chains/ports/caip.types';
import {
  CallClassValue,
  IntentStatusValue,
  NOT_CREDITED_CLASSES,
  NotCreditedClass,
  ResponseClassValue,
  classifyForReconciliation,
  isNotCredited,
} from '@modules/provider/domain/call-reconciliation';
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
/**
 * Held for the dispute window, or by an open dispute (G3.B1): rail B in the
 * escrow's `held[payer][seq]`, rail A as a withheld ledger credit. Not payable
 * until collected; never if an upheld dispute refunds it. Disjoint from debt
 * and from every closed outcome, which all have `held_status` unset or not
 * `HELD`.
 */
const PENDING_SQL = `(intent.held_status = 'HELD')`;
const SETTLED_STATUS = 'SETTLED';
/** Never collected from the buyer: a written-off debt, or a legacy platform absorb. */
const UNCOLLECTED_SQL = `(COALESCE(${WRITTEN_OFF_SQL}, false) OR ${PLATFORM_ABSORBED_SQL})`;

interface EarningsRow {
  readonly key: string;
  readonly asset: string;
  readonly decimals: string;
  readonly calls: string;
  readonly earned: string;
  readonly platformFee: string;
  readonly forfeited: string;
  readonly forfeitedCalls: string;
  readonly debtOutstanding: string;
  readonly debtOutstandingCalls: string;
  readonly uncollected: string;
  readonly uncollectedCalls: string;
  readonly pendingInWindow: string;
  readonly pendingInWindowCalls: string;
}

/**
 * One group of calls sharing every input `classifyForReconciliation` reads,
 * within one report group. Postgres returns the flags as booleans, some
 * drivers as strings.
 */
interface ClassifiableRow {
  readonly key: string;
  readonly asset: string;
  readonly decimals: string;
  readonly callClass: string;
  readonly status: string;
  readonly classification: string | null;
  readonly awaitingRedemption: boolean | string | null;
  readonly uncollected: boolean | string | null;
  readonly debtOutstanding: boolean | string | null;
  readonly forfeited: boolean | string | null;
  readonly voided: boolean | string | null;
  readonly calls: string;
  readonly providerAmount: string;
}

/** Calls and Σ provider_amount for one not-credited class. */
interface ClassFigure {
  readonly calls: number;
  readonly amount: bigint;
}

type WithheldByClass = Readonly<Record<NotCreditedClass, ClassFigure>>;

const ZERO_BY_CLASS: WithheldByClass = Object.freeze(
  Object.fromEntries(NOT_CREDITED_CLASSES.map((cls) => [cls, { calls: 0, amount: 0n }])),
) as WithheldByClass;

interface Figures {
  readonly calls: number;
  readonly earned: bigint;
  readonly platformFee: bigint;
  readonly withheldByClass: WithheldByClass;
  readonly forfeited: bigint;
  readonly forfeitedCalls: number;
  readonly debtOutstanding: bigint;
  readonly debtOutstandingCalls: number;
  readonly uncollected: bigint;
  readonly uncollectedCalls: number;
  readonly pendingInWindow: bigint;
  readonly pendingInWindowCalls: number;
}

const ZERO_FIGURES: Figures = {
  calls: 0,
  earned: 0n,
  platformFee: 0n,
  withheldByClass: ZERO_BY_CLASS,
  forfeited: 0n,
  forfeitedCalls: 0,
  debtOutstanding: 0n,
  debtOutstandingCalls: 0,
  uncollected: 0n,
  uncollectedCalls: 0,
  pendingInWindow: 0n,
  pendingInWindowCalls: 0,
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
    // matches the earnings ledger. The platform never pays or owes a provider:
    // forfeited, outstanding-debt and uncollected calls are reported apart and
    // are not earned.
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
      // Credited only (`CREDITED_SQL`), and so out of the buyer's escrow: a
      // call that was not collected took no fee either.
      .addSelect(
        `COALESCE(SUM(CASE WHEN intent.status = :settledStatus AND ${CREDITED_SQL} ` +
          `THEN intent.platformFee ELSE 0 END), 0)`,
        'platformFee',
      )
      // The provider caused the payment to fail: nobody pays it.
      .addSelect(
        `COALESCE(SUM(CASE WHEN intent.status = :settledStatus AND COALESCE(${FORFEITED_SQL}, false) ` +
          `THEN intent.providerAmount ELSE 0 END), 0)`,
        'forfeited',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE intent.status = :settledStatus AND COALESCE(${FORFEITED_SQL}, false))`,
        'forfeitedCalls',
      )
      // Buyer debt still open: held in the buyer's escrow, paid once re-signed.
      .addSelect(
        `COALESCE(SUM(CASE WHEN intent.status = :settledStatus AND ${DEBT_OUTSTANDING_SQL} ` +
          `THEN intent.providerAmount ELSE 0 END), 0)`,
        'debtOutstanding',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE intent.status = :settledStatus AND ${DEBT_OUTSTANDING_SQL})`,
        'debtOutstandingCalls',
      )
      // Never collected: a written-off debt, or a legacy absorb (nobody owes it).
      .addSelect(
        `COALESCE(SUM(CASE WHEN intent.status = :settledStatus AND NOT COALESCE(${FORFEITED_SQL}, false) ` +
          `AND (COALESCE(${WRITTEN_OFF_SQL}, false) OR ${PLATFORM_ABSORBED_SQL}) ` +
          `THEN intent.providerAmount ELSE 0 END), 0)`,
        'uncollected',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE intent.status = :settledStatus AND NOT COALESCE(${FORFEITED_SQL}, false) ` +
          `AND (COALESCE(${WRITTEN_OFF_SQL}, false) OR ${PLATFORM_ABSORBED_SQL}))`,
        'uncollectedCalls',
      )
      // Held for the dispute window or an open dispute, or being collected:
      // still in the buyer's escrow, not yet payable (`PENDING_SQL`).
      .addSelect(
        `COALESCE(SUM(CASE WHEN intent.status = :settledStatus AND ${PENDING_SQL} THEN intent.providerAmount ELSE 0 END), 0)`,
        'pendingInWindow',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE intent.status = :settledStatus AND ${PENDING_SQL})`,
        'pendingInWindowCalls',
      )
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.providerId = :providerId', { providerId })
      .andWhere('intent.createdAt >= :from', { from })
      .andWhere('intent.createdAt < :to', { to })
      .setParameters({ settledStatus: SETTLED_STATUS });

    if (query.asset) {
      qb.andWhere('intent.assetId = :assetId', { assetId: query.asset });
    }

    const rows = await qb
      .groupBy(groupExpr)
      .addGroupBy('intent.assetId')
      .addGroupBy('intent.decimals')
      .getRawMany<EarningsRow>();

    const withheld = await this.withheldByGroup(providerId, from, to, groupExpr, query.asset);

    const asset = resolveAsset(rows, query.asset);
    const decimals = asset ? Number(rows.find((r) => r.asset === asset)?.decimals ?? 0) : 0;

    const figuresOf = (row: EarningsRow) =>
      toFigures(row, withheld.get(groupKey(row)) ?? ZERO_BY_CLASS);

    const groups: ProviderEarningsGroupDto[] = rows.map((row) => ({
      key: row.key,
      ...toFiguresDto(figuresOf(row), asset, decimals),
    }));

    const totals = rows.reduce<Figures>(
      (total, row) => addFigures(total, figuresOf(row)),
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

  /**
   * "Not credited", per report group and class: the calls the per-call export
   * classifies into {@link NOT_CREDITED_CLASSES}, held or not (D17).
   *
   * Grouped by every input `classifyForReconciliation` reads, then classified
   * here by that same function — not restated in SQL — so this figure, its
   * reasons and the export count the same calls by construction (UX review
   * 2026-10-18, D-P0-1: the summary once required a hold the export did not,
   * and read 14 calls beside 22 in its own reasons).
   */
  private async withheldByGroup(
    providerId: string,
    from: Date,
    to: Date,
    groupExpr: string,
    asset: string | undefined,
  ): Promise<Map<string, WithheldByClass>> {
    const qb = this.intents
      .createQueryBuilder('intent')
      .select(groupExpr, 'key')
      .addSelect('intent.assetId', 'asset')
      .addSelect('intent.decimals', 'decimals')
      .addSelect('intent.callClass', 'callClass')
      .addSelect('intent.status', 'status')
      .addSelect('intent.classification', 'classification')
      .addSelect(AWAITING_REDEMPTION_SQL, 'awaitingRedemption')
      .addSelect(UNCOLLECTED_SQL, 'uncollected')
      .addSelect(DEBT_OUTSTANDING_SQL, 'debtOutstanding')
      .addSelect(FORFEITED_SQL, 'forfeited')
      .addSelect(VOIDED_SQL, 'voided')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COALESCE(SUM(intent.providerAmount), 0)', 'providerAmount')
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.providerId = :providerId', { providerId })
      .andWhere('intent.createdAt >= :from', { from })
      .andWhere('intent.createdAt < :to', { to });

    if (asset) {
      qb.andWhere('intent.assetId = :assetId', { assetId: asset });
    }

    const rows = await qb
      .groupBy(groupExpr)
      .addGroupBy('intent.assetId')
      .addGroupBy('intent.decimals')
      .addGroupBy('intent.callClass')
      .addGroupBy('intent.status')
      .addGroupBy('intent.classification')
      .addGroupBy(AWAITING_REDEMPTION_SQL)
      .addGroupBy(UNCOLLECTED_SQL)
      .addGroupBy(DEBT_OUTSTANDING_SQL)
      .addGroupBy(FORFEITED_SQL)
      .addGroupBy(VOIDED_SQL)
      .getRawMany<ClassifiableRow>();

    const byGroup = new Map<string, Record<NotCreditedClass, ClassFigure>>();
    for (const row of rows) {
      const cls = classifyForReconciliation({
        callClass: row.callClass as CallClassValue,
        status: row.status as IntentStatusValue,
        classification: row.classification as ResponseClassValue,
        awaitingRedemption: flag(row.awaitingRedemption),
        uncollected: flag(row.uncollected),
        debtOutstanding: flag(row.debtOutstanding),
        forfeited: flag(row.forfeited),
        voided: flag(row.voided),
      });
      if (!isNotCredited(cls)) continue;

      const key = groupKey(row);
      const figures = byGroup.get(key) ?? { ...ZERO_BY_CLASS };
      figures[cls] = {
        calls: figures[cls].calls + Number(row.calls),
        amount: figures[cls].amount + BigInt(row.providerAmount),
      };
      byGroup.set(key, figures);
    }
    return byGroup;
  }
}

/** A report group: its key, in one asset. */
function groupKey(row: { key: string; asset: string; decimals: string }): string {
  return `${row.key}\u0000${row.asset}\u0000${row.decimals}`;
}

function flag(value: boolean | string | null): boolean {
  return value === true || value === 'true';
}

function sumByClass(byClass: WithheldByClass): ClassFigure {
  return NOT_CREDITED_CLASSES.reduce<ClassFigure>(
    (total, cls) => ({
      calls: total.calls + byClass[cls].calls,
      amount: total.amount + byClass[cls].amount,
    }),
    { calls: 0, amount: 0n },
  );
}

function addByClass(a: WithheldByClass, b: WithheldByClass): WithheldByClass {
  return Object.fromEntries(
    NOT_CREDITED_CLASSES.map((cls) => [
      cls,
      { calls: a[cls].calls + b[cls].calls, amount: a[cls].amount + b[cls].amount },
    ]),
  ) as WithheldByClass;
}

function resolveAsset(rows: readonly EarningsRow[], requested?: string): AssetId | null {
  if (requested) return requested as AssetId;

  const distinct = [...new Set(rows.map((row) => row.asset))];
  if (distinct.length > 1) {
    throw ProviderErrors.multipleAssets({ assets: distinct.join(', ') });
  }
  return (distinct[0] as AssetId | undefined) ?? null;
}

function toFigures(row: EarningsRow, withheldByClass: WithheldByClass): Figures {
  return {
    calls: Number(row.calls),
    earned: BigInt(row.earned),
    platformFee: BigInt(row.platformFee),
    withheldByClass,
    forfeited: BigInt(row.forfeited),
    forfeitedCalls: Number(row.forfeitedCalls),
    debtOutstanding: BigInt(row.debtOutstanding),
    debtOutstandingCalls: Number(row.debtOutstandingCalls),
    uncollected: BigInt(row.uncollected),
    uncollectedCalls: Number(row.uncollectedCalls),
    pendingInWindow: BigInt(row.pendingInWindow),
    pendingInWindowCalls: Number(row.pendingInWindowCalls),
  };
}

function addFigures(a: Figures, b: Figures): Figures {
  return {
    calls: a.calls + b.calls,
    earned: a.earned + b.earned,
    platformFee: a.platformFee + b.platformFee,
    withheldByClass: addByClass(a.withheldByClass, b.withheldByClass),
    forfeited: a.forfeited + b.forfeited,
    forfeitedCalls: a.forfeitedCalls + b.forfeitedCalls,
    debtOutstanding: a.debtOutstanding + b.debtOutstanding,
    debtOutstandingCalls: a.debtOutstandingCalls + b.debtOutstandingCalls,
    uncollected: a.uncollected + b.uncollected,
    uncollectedCalls: a.uncollectedCalls + b.uncollectedCalls,
    pendingInWindow: a.pendingInWindow + b.pendingInWindow,
    pendingInWindowCalls: a.pendingInWindowCalls + b.pendingInWindowCalls,
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
  // The summary is the sum of its reasons, never a second query.
  const withheld = sumByClass(figures.withheldByClass);
  return {
    calls: figures.calls,
    earned: money(figures.earned),
    platformFee: money(figures.platformFee),
    withheld: money(withheld.amount),
    withheldCalls: withheld.calls,
    withheldByClass: NOT_CREDITED_CLASSES.map((cls) => ({
      class: cls,
      calls: figures.withheldByClass[cls].calls,
      amount: money(figures.withheldByClass[cls].amount),
    })),
    forfeited: money(figures.forfeited),
    forfeitedCalls: figures.forfeitedCalls,
    debtOutstanding: money(figures.debtOutstanding),
    debtOutstandingCalls: figures.debtOutstandingCalls,
    uncollected: money(figures.uncollected),
    uncollectedCalls: figures.uncollectedCalls,
    pendingInWindow: money(figures.pendingInWindow),
    pendingInWindowCalls: figures.pendingInWindowCalls,
  };
}
