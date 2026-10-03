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
  WITHHELD_BUCKET_LABEL,
  WITHHELD_STATUS_BUCKET,
  WithheldBucket,
  WithheldBucketTotal,
  WithheldPeriod,
  WithheldReconciliation,
  WithheldTotal,
  reconcileWithheld,
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
 * (`Σ` listed price over the withheld statuses that had a hold). Neither is
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

  /** The intent side: `Σ` listed price over the withheld buckets, for one asset. */
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
   * `holdReleaseTotal == withheld + orphanedReleases` — see `domain/withheld.ts`.
   */
  async reconcile(
    organizationId: string,
    asset: AssetId,
    decimals: number,
    period: WithheldPeriod = {},
  ): Promise<WithheldReconciliation> {
    const [withheld, holdReleaseTotal, orphans] = await Promise.all([
      this.withheldFromIntents(organizationId, asset, decimals, period),
      this.withheldFromJournal(organizationId, asset, decimals, period),
      this.entries.findOrphanedHoldReleases(organizationId, period),
    ]);

    const orphansForAsset = orphans.filter((orphan) => orphan.asset === asset);
    const orphanedAtomic = orphansForAsset.reduce((total, orphan) => total + orphan.amount, 0n);

    return reconcileWithheld({
      withheld,
      holdReleaseTotal,
      orphanedReleases: MoneyUtil.of(orphanedAtomic, asset, decimals),
      orphanedHoldIds: orphansForAsset.map((orphan) => orphan.holdId),
    });
  }
}

/**
 * Folds pre-aggregated `(asset, status)` rows into a `WithheldTotal`.
 *
 * The status → bucket mapping is `WITHHELD_STATUS_BUCKET` from
 * `domain/withheld.ts`, never re-derived: two statuses can share a bucket
 * (`VOIDED` and `EXPIRED` both land in `PROVIDER_OR_PLATFORM_ERROR`), so this
 * is a many-to-one fold, not a relabelling.
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
    const bucket = WITHHELD_STATUS_BUCKET[row.status];
    if (!bucket) continue; // the repository already filters to WITHHELD_STATUSES; defensive only.

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
