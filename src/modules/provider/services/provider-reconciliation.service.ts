import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  AWAITING_REDEMPTION_SQL,
  CREDITED_SQL,
  FORFEITED_SQL,
  DEBT_OUTSTANDING_SQL,
  VOIDED_SQL,
  WRITTEN_OFF_SQL,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import { platformTakeRatePercent } from '@modules/mcp/services/mcp-pricing.config';
import { AssetId, isAssetId } from '@modules/chains/ports/caip.types';
import {
  CALL_RECONCILIATION_CLASSES,
  CallClassValue,
  CallReconciliationClass,
  IntentStatusValue,
  ResponseClassValue,
  classifyForReconciliation,
} from '@modules/provider/domain/call-reconciliation';
import { ApiErrors } from '@shared/api';

import {
  GetProviderReconciliationQueryDto,
  GetProviderReconciliationResponseDto,
  ReconciliationClassRowDto,
} from '../dto/provider-reconciliation.dto';
import { ProviderErrors } from '../errors/provider.errors';

const SETTLED_STATUS = 'SETTLED';

/** Never collected from the buyer: a written-off debt. */
const UNCOLLECTED_GROUP_SQL = `COALESCE(${WRITTEN_OFF_SQL}, false)`;

/** One `(call_class, status, classification, asset, decimals)` group, still atomic-unit strings. */
interface ReconciliationGroupRow {
  readonly callClass: string;
  readonly status: string;
  readonly classification: string | null;
  readonly asset: string;
  readonly decimals: string;
  /** Rail B, hold still open — Postgres returns a boolean, some drivers a string. */
  readonly awaitingRedemption: boolean | string;
  /** Never collected: a written-off debt — same driver caveat. */
  readonly uncollected: boolean | string | null;
  /** Open buyer debt — same driver caveat. */
  readonly debtOutstanding: boolean | string | null;
  /** `CREDITED_SQL`: the hold was committed — same driver caveat. */
  readonly holdCommitted: boolean | string;
  /** `FORFEITED_SQL`: the provider forfeited — same driver caveat (and may be NULL). */
  readonly forfeited: boolean | string | null;
  /** `VOIDED_SQL`: a debt voided by a late rejecting verdict — same caveat. */
  readonly voided?: boolean | string | null;
  readonly calls: string;
  /** `Σ price_amount` over this group's `SETTLED` rows. */
  readonly credited: string;
  /** `Σ provider_amount` over this group's `SETTLED` rows. */
  readonly providerAmount: string;
  /** `Σ platform_fee` over this group's `SETTLED` rows. */
  readonly platformFee: string;
}

/** Accumulator for one {@link CallReconciliationClass}. */
interface ClassAccumulator {
  calls: number;
  /** Σ provider_amount — net of the platform fee. */
  credited: bigint;
  /** Σ price_amount — before the platform fee. */
  gross: bigint;
}

/**
 * The per-class prose for the "why we credited less than you served" table.
 * Kept as static text
 * rather than derived: the note is a fixed description of what the *class*
 * means, not a per-response computation.
 *
 * Four of these nine describe traffic with **no producer yet** —
 * `TEST`/`EXPLORATION`/`EXCLUDED` (see `call-reconciliation.ts`'s own header
 * comment) and canaries, which never appear as their own row at all (folded
 * into `PAID_CREDITED`, see `ReconciliationCanaryAggregateRowDto`). Their
 * note text still describes the class honestly rather than announcing the
 * gap, because the gap is a property of *this deployment's* traffic, not of
 * the class — the day a producer ships, the same note stays true without an
 * edit.
 */
const CLASS_NOTES: Record<CallReconciliationClass, string> = {
  [CallReconciliationClass.PAID_CREDITED]: 'settled to you',
  [CallReconciliationClass.PAID_AWAITING_REDEMPTION]:
    'passed — credited once the voucher is redeemed on chain',
  [CallReconciliationClass.PAID_BUYER_DEBT]:
    'passed — the buyer’s payment could not be collected yet; credited from the buyer’s ' +
    'escrow once the buyer re-signs it',
  [CallReconciliationClass.PAID_UNCOLLECTED]:
    'passed — the buyer never paid and the debt was written off; not credited, no fee taken',
  [CallReconciliationClass.PROVIDER_FORFEITED]:
    'voucher not collected because of your stake or a block — forfeited, not credited',
  [CallReconciliationClass.PAID_UNCREDITED]: 'verification found FAIL — not credited, see verdicts',
  [CallReconciliationClass.FREE]: 'relay path, no payment machinery',
  [CallReconciliationClass.TEST]: 'your own dry runs — charges nobody',
  [CallReconciliationClass.EXPLORATION]:
    'NEW-binding trial traffic: the buyer paid; verification sampled at platform cost',
  [CallReconciliationClass.EXCLUDED]:
    'griefing attribution — credited, not counted against your SLA',
  [CallReconciliationClass.SYSTEM_ERROR]: 'upstream 5xx / timeout',
  [CallReconciliationClass.REQUEST_ERROR]: '4xx from your endpoint',
  [CallReconciliationClass.PENDING]: 'still in flight — not resolved yet',
};

/**
 * `GET /providers/me/reconciliation`.
 *
 * **This is the provider's own books, not `reconciliation_runs`** — that
 * table is the platform's internal vault-vs-ledger reconciler and belongs to
 * a different module. This answers "why did we credit you less than you
 * served", broken down by {@link CallReconciliationClass}.
 *
 * ## Reuse, not re-derivation
 *
 * The class vocabulary and the classification function are
 * `@modules/provider/domain/call-reconciliation`'s — the exact ones
 * `ProviderCallsExportService`'s per-call CSV classifies each row
 * with. This endpoint calls the same `classifyForReconciliation`, so a call
 * this endpoint's aggregate and that CSV's per-row export disagree about is a
 * defect in the shared function, never a second implementation to keep in
 * sync by hand.
 *
 * ## Why this is a raw `createQueryBuilder` aggregate, not a page-and-fold
 *
 * `ProviderEarningsService` and `ProviderQualityService` (siblings on this
 * same cross-organization surface) both aggregate in SQL rather than pulling
 * every row into the process — a provider's month can be 1.5M calls, and
 * summing that many rows in Node one request at a time is the exact anti-
 * pattern `PaymentIntentRepository.summarizeReceipts`'s doc comment calls
 * out. Grouping by `(call_class, status, classification)` keeps the result
 * set to a handful of rows — the classification is then applied once per
 * *group*, in JS, over that handful, not once per call.
 *
 * ## "Unexplained" — see `ReconciliationUnexplainedDto`
 *
 * `classifyForReconciliation` is total: every input reaches a member of
 * `CallReconciliationClass`, so nothing here is *expected* to be
 * unclassifiable. The `try`/`catch` around it is a belt this file wears
 * anyway, so that "calls that classify into nothing" surfaces as a non-zero,
 * referenced `unexplained` count in the response — a platform defect the
 * screen files as one — rather than a 500 or a silently dropped row.
 *
 * ## Scoped exactly like `ProviderEarningsService`
 *
 * `payment_intents.organization_id` is the *buyer's* org; a provider's calls
 * span every buying organization, not its own. `organizationId IS NOT NULL`
 * satisfies `OrganizationScopedRepository`'s guard while `provider_id =
 * :providerId` does the real scoping — see that class's doc comment for the
 * full justification, not repeated here.
 */
@Injectable()
export class ProviderReconciliationService {
  constructor(
    private readonly intents: PaymentIntentRepository,
    private readonly config: ConfigService,
  ) {}

  async getReconciliation(
    providerId: string,
    query: GetProviderReconciliationQueryDto,
  ): Promise<GetProviderReconciliationResponseDto> {
    const from = new Date(query.from);
    const to = new Date(query.to);

    if (!(from.getTime() < to.getTime())) {
      throw ProviderErrors.invalidTimeRange({ from: query.from, to: query.to });
    }
    if (query.asset !== undefined && !isAssetId(query.asset)) {
      throw ApiErrors.invalidFilter({ filter: 'asset', value: query.asset });
    }

    const groupRows = await this.queryGroups(providerId, from, to, query.asset);

    const asset = resolveAsset(groupRows, query.asset);
    const decimals = asset ? decimalsFor(asset, groupRows) : 0;
    const money = (amount: bigint) =>
      asset === null ? null : { amount: amount.toString(), asset, decimals };

    const buckets = new Map<CallReconciliationClass, ClassAccumulator>(
      CALL_RECONCILIATION_CLASSES.map((cls) => [cls, { calls: 0, credited: 0n, gross: 0n }]),
    );

    let callCount = 0;
    let grossAmount = 0n;
    let netAmount = 0n;
    let platformTakeAmount = 0n;
    let unexplainedCalls = 0;
    let unexplainedReference: string | null = null;

    for (const row of groupRows) {
      const calls = Number(row.calls);
      callCount += calls;

      try {
        const awaitingRedemption =
          row.awaitingRedemption === true || row.awaitingRedemption === 'true';
        const cls = classifyForReconciliation({
          callClass: row.callClass as CallClassValue,
          status: row.status as IntentStatusValue,
          classification: row.classification as ResponseClassValue,
          awaitingRedemption,
          uncollected: row.uncollected === true || row.uncollected === 'true',
          debtOutstanding: row.debtOutstanding === true || row.debtOutstanding === 'true',
          forfeited: row.forfeited === true || row.forfeited === 'true',
          voided: row.voided === true || row.voided === 'true',
          credited: !(row.holdCommitted === false || row.holdCommitted === 'false'),
        });
        // `CALL_RECONCILIATION_CLASSES` pre-seeds every member above, so this
        // lookup cannot miss for any value `classifyForReconciliation` can
        // actually return — defensive, not a real branch.
        const bucket = buckets.get(cls);
        if (!bucket) throw new Error(`unmapped reconciliation class: ${cls}`);

        // Not credited yet: counted as calls, kept out of every settled figure
        // until the redemption lands and the earnings ledger holds the credit.
        if (
          cls === CallReconciliationClass.PAID_AWAITING_REDEMPTION ||
          cls === CallReconciliationClass.PAID_BUYER_DEBT
        ) {
          bucket.calls += calls;
          continue;
        }

        // A class row's `credited` is what reached the provider — net of the
        // platform fee, so PAID_CREDITED's "settled to you" matches
        // PROVIDER_CREDIT and the chain. The gross price only feeds `gross`.
        // All three parsed before anything moves, so a corrupt group lands in
        // `unexplained` whole rather than half-counted.
        const priceAmount = BigInt(row.credited);
        const providerAmount = BigInt(row.providerAmount);
        // Money is summed for committed holds only (`CREDITED_SQL`), so a
        // forfeited or uncollected group carries zeros here.
        const platformFee = BigInt(row.platformFee);
        bucket.calls += calls;
        bucket.credited += providerAmount;
        bucket.gross += priceAmount;

        grossAmount += priceAmount;
        netAmount += providerAmount;
        platformTakeAmount += platformFee;
      } catch {
        // `classifyForReconciliation` is total (see its own doc comment) —
        // this branch should be unreachable — so a group that lands here is
        // this endpoint's own defect, not the provider's. It is counted, not
        // dropped, and given a stable reference a support thread can carry.
        unexplainedCalls += calls;
        unexplainedReference ??= buildUnexplainedReference(providerId, query.from, query.to);
      }
    }

    const classBreakdown: ReconciliationClassRowDto[] = CALL_RECONCILIATION_CLASSES.map((cls) => {
      const bucket = buckets.get(cls) as ClassAccumulator;
      return {
        class: cls,
        calls: bucket.calls,
        share: callCount === 0 ? 0 : bucket.calls / callCount,
        credited: money(bucket.credited),
        gross: money(bucket.gross),
        note: CLASS_NOTES[cls],
      };
    });

    // The rate a call is charged at today (`PLATFORM_FEE_BPS`, the value
    // `MCP_PRICING` splits every live call with): this number sits next to the
    // real Σ platform_fee, and only the charged rate is one that sum can be
    // checked against (R17-R-03).
    const takeRatePercent = platformTakeRatePercent(this.config);

    return {
      from: query.from,
      to: query.to,
      asset,
      callCount,
      classBreakdown,
      unexplained: { calls: unexplainedCalls, reference: unexplainedReference },
      gross: money(grossAmount),
      platformTakeRatePercent: takeRatePercent,
      platformTake: money(platformTakeAmount),
      net: money(netAmount),
      // No producer exists anywhere in this codebase for a canary flag — see
      // the DTO's own doc comment. A real, honest `[]`, not an omitted field.
      monthlyCanaryAggregate: [],
    };
  }

  private async queryGroups(
    providerId: string,
    from: Date,
    to: Date,
    asset: string | undefined,
  ): Promise<ReconciliationGroupRow[]> {
    const qb = this.intents
      .createQueryBuilder('intent')
      .select('intent.callClass', 'callClass')
      .addSelect('intent.status', 'status')
      .addSelect('intent.classification', 'classification')
      .addSelect('intent.assetId', 'asset')
      .addSelect('intent.decimals', 'decimals')
      .addSelect(AWAITING_REDEMPTION_SQL, 'awaitingRedemption')
      .addSelect(UNCOLLECTED_GROUP_SQL, 'uncollected')
      .addSelect(DEBT_OUTSTANDING_SQL, 'debtOutstanding')
      .addSelect(CREDITED_SQL, 'holdCommitted')
      .addSelect(FORFEITED_SQL, 'forfeited')
      .addSelect(VOIDED_SQL, 'voided')
      .addSelect('COUNT(*)', 'calls')
      // Money only for committed holds (`CREDITED_SQL`), the same rule as
      // `ProviderEarningsService`, so gross / take / net match `PROVIDER_CREDIT`.
      .addSelect(
        `COALESCE(SUM(CASE WHEN intent.status = :settledStatus AND ${CREDITED_SQL} ` +
          `THEN intent.priceAmount ELSE 0 END), 0)`,
        'credited',
      )
      .addSelect(
        `COALESCE(SUM(CASE WHEN intent.status = :settledStatus AND ${CREDITED_SQL} ` +
          `THEN intent.providerAmount ELSE 0 END), 0)`,
        'providerAmount',
      )
      .addSelect(
        `COALESCE(SUM(CASE WHEN intent.status = :settledStatus AND ${CREDITED_SQL} ` +
          `THEN intent.platformFee ELSE 0 END), 0)`,
        'platformFee',
      )
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.providerId = :providerId', { providerId })
      .andWhere('intent.createdAt >= :from', { from })
      .andWhere('intent.createdAt < :to', { to })
      .setParameters({ settledStatus: SETTLED_STATUS });

    if (asset) {
      qb.andWhere('intent.assetId = :assetId', { assetId: asset });
    }

    return qb
      .groupBy('intent.callClass')
      .addGroupBy('intent.status')
      .addGroupBy('intent.classification')
      .addGroupBy('intent.assetId')
      .addGroupBy('intent.decimals')
      .addGroupBy(AWAITING_REDEMPTION_SQL)
      .addGroupBy(UNCOLLECTED_GROUP_SQL)
      .addGroupBy(DEBT_OUTSTANDING_SQL)
      .addGroupBy(CREDITED_SQL)
      .addGroupBy(FORFEITED_SQL)
      .addGroupBy(VOIDED_SQL)
      .getRawMany<ReconciliationGroupRow>();
  }
}

/**
 * Same rule as `ProviderEarningsService.resolveAsset`: an explicit `?asset=`
 * wins outright; otherwise the window must name at most one asset or there is
 * nothing honest to denominate a total in.
 */
function resolveAsset(rows: readonly { asset: string }[], requested?: string): AssetId | null {
  if (requested) return requested as AssetId;

  const distinct = [...new Set(rows.map((row) => row.asset))];
  if (distinct.length > 1) {
    throw ProviderErrors.multipleAssets({ assets: distinct.join(', ') });
  }
  return (distinct[0] as AssetId | undefined) ?? null;
}

function decimalsFor(
  asset: AssetId,
  groupRows: readonly { asset: string; decimals: string }[],
): number {
  const match = groupRows.find((row) => row.asset === asset);
  return match ? Number(match.decimals) : 0;
}

/**
 * A deterministic reference for an `unexplained` incident — `rec_XXXXXXXX`,
 * in the `rec_0J8K` style the console shows. Deterministic rather than
 * `randomUUID()`-per-request: the same defect, re-queried, must carry the
 * same reference so a provider and support are looking at the same incident.
 */
function buildUnexplainedReference(providerId: string, from: string, to: string): string {
  const digest = createHash('sha256').update(`${providerId}|${from}|${to}`).digest('hex');
  return `rec_${digest.slice(0, 8)}`;
}
