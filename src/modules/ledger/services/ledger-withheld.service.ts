import { Injectable } from '@nestjs/common';

import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import {
  PaymentIntentRepository,
  WithheldStatusAssetTotal,
} from '@database/postgres/repositories/payment-intent.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  MAX_LISTED_ORPHANED_HOLD_IDS,
  WITHHELD_BUCKET_LABEL,
  WithheldBucket,
  WithheldBucketTotal,
  WithheldPeriod,
  WithheldReconciliation,
  WithheldTotal,
  reconcileWithheld,
  withheldBucketOf,
} from '../domain/withheld';
import { LedgerEntryType } from '../ports/ledger.types';

/**
 * The two independent computations of `withheld`, and the
 * reconciliation between them.
 *
 * This class is to `withheld` what `LedgerBalanceService` is to a balance:
 * `getBalance` reads a cache and `rebuildBalance` folds the journal, and the
 * two are compared rather than one being trusted. Here, `withheldFromJournal`
 * is the ledger side (`Σ HOLD_RELEASE`) and the intent-side computation below
 * is a second, independently-obtained route to the same number
 * (`Σ` held amount over the withheld statuses that had a hold). Neither is
 * derived from the other; `reconcile` is what decides whether they agree.
 *
 * See `domain/withheld.ts` for the definition this file is not — that file is
 * pure and untested by a database; this one is the two SQL routes to the
 * numbers it folds.
 *
 * ## `decimals` is a parameter, and this class no longer reads the asset registry
 *
 * Every figure here is scaled by the asset's `decimals`, and the rows carry it
 * — except when there are no rows, where a zero still has to be quoted at
 * *some* scale. That fallback used to be `getAssetMetadata(asset).decimals`,
 * which made an unregistered asset throw `CHAIN_ASSET_UNKNOWN` and take the
 * whole of `GET /balances` down with it: one organization holding a
 * historical row in a retired token saw **no balances at all**, because the
 * response is assembled per asset and one asset refused.
 *
 * The scale now comes from the caller, who reads it off the ledger row it is
 * reporting — a database fact about the very rows being folded, and a stricter
 * source than the registry, which only knows the assets this platform settles
 * *today*. It is required rather than optional so the compiler finds every
 * caller instead of one of them quietly inheriting a wrong scale.
 *
 * **This does not weaken any check.** The registry is still what
 * `LedgerJournalService` consults before *writing* an entry, so an entry in an
 * unregistered asset still cannot be created; what changed is that reporting
 * one that already exists no longer needs the registry's permission.
 */
@Injectable()
export class LedgerWithheldService {
  constructor(
    private readonly entries: LedgerEntryRepository,
    private readonly intents: PaymentIntentRepository,
  ) {}

  /**
   * The ledger side: `Σ HOLD_RELEASE`, for one asset, in atomic units.
   *
   * `decimals` is only reached for when there is no row — see the class
   * comment. A row's own scale always wins over it.
   */
  async withheldFromJournal(
    organizationId: string,
    asset: AssetId,
    decimals: number,
    period: WithheldPeriod = {},
  ): Promise<Money> {
    const rows = await this.entries.sumEntryTypeByAsset(
      organizationId,
      LedgerEntryType.HOLD_RELEASE,
      period,
    );
    const row = rows.find((candidate) => candidate.asset === asset);

    if (!row) {
      return MoneyUtil.zero(asset, decimals);
    }
    return MoneyUtil.of(row.amount, asset, row.decimals);
  }

  /**
   * The intent side: `Σ` held amount over the withheld buckets, for one asset.
   * The `NOT_COLLECTED` bucket is here too: its hold was released, so it is in
   * `Σ HOLD_RELEASE`, and leaving it out failed the reconciliation by its amount.
   */
  async withheldFromIntents(
    organizationId: string,
    asset: AssetId,
    decimals: number,
    period: WithheldPeriod = {},
  ): Promise<WithheldTotal> {
    const rows = await this.intents.sumWithheldByAssetAndStatus(organizationId, period);
    return toWithheldTotal(
      asset,
      decimals,
      rows.filter((row) => row.asset === asset),
    );
  }

  /**
   * Both sides, folded into the honest identity
   * `holdReleaseTotal == withheld + settlementRemainders + orphanedReleases` — see
   * `domain/withheld.ts`.
   */
  async reconcile(
    organizationId: string,
    asset: AssetId,
    decimals: number,
    period: WithheldPeriod = {},
  ): Promise<WithheldReconciliation> {
    const [withheld, holdReleaseTotal, summaries] = await Promise.all([
      this.withheldFromIntents(organizationId, asset, decimals, period),
      this.withheldFromJournal(organizationId, asset, decimals, period),
      this.entries.summarizeOrphanedHoldReleases(
        organizationId,
        period,
        MAX_LISTED_ORPHANED_HOLD_IDS,
      ),
    ]);

    const forAsset = summaries.filter((summary) => summary.asset === asset);
    const sum = (term: (row: (typeof forAsset)[number]) => bigint) =>
      forAsset.reduce((total, row) => total + term(row), 0n);

    return reconcileWithheld({
      withheld,
      holdReleaseTotal,
      orphanedReleases: MoneyUtil.of(
        sum((row) => row.orphanedReleases),
        asset,
        decimals,
      ),
      orphanedHoldIds: forAsset.flatMap((row) => row.orphanedHoldIds),
      orphanedHoldCount: forAsset.reduce((total, row) => total + row.orphanedHoldCount, 0),
      settlementRemainders: MoneyUtil.of(
        sum((row) => row.settlementRemainders),
        asset,
        decimals,
      ),
    });
  }
}

/** Stands in for the hold id the query already required (`hold_id IS NOT NULL`). */
const HELD = 'held';

/**
 * Folds pre-aggregated `(asset, status)` rows into a `WithheldTotal`.
 *
 * The row → bucket mapping is `withheldBucketOf` from `domain/withheld.ts`,
 * never re-derived: two statuses can share a bucket (`VOIDED` and `EXPIRED`
 * both land in `PROVIDER_OR_PLATFORM_ERROR`), so this is a many-to-one fold,
 * not a relabelling. Every row had a hold (the query requires one).
 */
function toWithheldTotal(
  asset: AssetId,
  fallbackDecimals: number,
  rows: readonly WithheldStatusAssetTotal[],
): WithheldTotal {
  const decimals = rows[0]?.decimals ?? fallbackDecimals;

  const perBucket = new Map<WithheldBucket, { calls: number; amount: bigint }>();
  for (const bucket of Object.values(WithheldBucket)) {
    perBucket.set(bucket, { calls: 0, amount: 0n });
  }

  for (const row of rows) {
    const bucket = withheldBucketOf({
      status: row.status,
      holdId: HELD,
      notCollected: row.notCollected,
    });
    if (!bucket) continue; // the repository already filters to withheld rows; defensive only.

    const running = perBucket.get(bucket) as { calls: number; amount: bigint };
    running.calls += row.calls;
    running.amount += row.amount;
  }

  const buckets: WithheldBucketTotal[] = Object.values(WithheldBucket).map((bucket) => {
    const running = perBucket.get(bucket) as { calls: number; amount: bigint };
    return {
      bucket,
      label: WITHHELD_BUCKET_LABEL[bucket],
      calls: running.calls,
      amount: MoneyUtil.of(running.amount, asset, decimals),
    };
  });

  return {
    asset,
    calls: buckets.reduce((total, bucket) => total + bucket.calls, 0),
    amount: MoneyUtil.sum(buckets.map((bucket) => bucket.amount)),
    buckets,
  };
}
