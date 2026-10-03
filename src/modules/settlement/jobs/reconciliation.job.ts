import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { settlementAssetsOn } from '@modules/chains/ports/asset-registry';
import { AssetId } from '@modules/chains/ports/caip.types';

import { RECONCILIATION_CRON } from '../constants/reconciliation.constants';
import { ReconciliationService } from '../services/reconciliation.service';

/**
 * The cron wrapper around `ReconciliationService.reconcile`.
 *
 * Registered only in `SettlementSchedulerModule`, which only the scheduler
 * process imports — the scheduler is a single instance by design
 * (`docs/architecture.md` §Scaling Design), so this fires once per deployment
 * rather than once per API replica.
 *
 * The handler cannot throw: `reconcile` records its own failures as runs and
 * resolves, and the loop below catches anything left so one asset's problem
 * cannot stop the next asset being checked. A cron handler that rejects is
 * logged by Nest and then forgotten, which is the failure mode this whole item
 * exists to eliminate.
 *
 * ## One chain at a time, and never a sum
 *
 * The work list is a `flatMap` over the enabled chains and the loop below
 * visits it one item at a time. It must stay that way. An asset belongs to
 * exactly one chain (`asset-registry.ts`), so an asset loop IS a chain loop,
 * and each `reconcile(asset)` therefore reconciles one chain against itself and
 * nothing else. A run that folded the chains into a single figure would report
 * a clean book while one chain was short and the other over — which is the
 * exact failure the chains' independence exists to prevent, and it would not be
 * observable at all until the second chain went live.
 *
 * Locked by `test/unit/architecture/no-cross-chain-invariant.spec.ts`, in three
 * ways: the shape of this file, the calls this job actually makes, and the
 * proof that removing one chain from `ENABLED_CHAINS` leaves the other chain's
 * call byte-identical.
 */
@Injectable()
export class ReconciliationJob {
  private readonly logger = new Logger(ReconciliationJob.name);

  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly chains: ChainAdapterRegistry,
  ) {}

  @Cron(RECONCILIATION_CRON)
  async handleReconciliation(): Promise<void> {
    for (const asset of this.assets()) {
      try {
        await this.reconciliation.reconcile(asset);
      } catch (error) {
        this.logger.error(
          `Reconciliation of ${asset} threw past its own error handling: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Which assets the vault custodies.
   *
   * Derived from the enabled chains rather than configured separately: the
   * vault holds USDC and only USDC in the MVP, so the set is
   * "the registered USDC of every chain this deployment serves". A separate
   * env var would be a second place to forget to add a chain, and forgetting
   * here means an asset nobody reconciles.
   *
   * Unregistered chains are skipped rather than thrown on — a chain the asset
   * registry does not know is a configuration question for boot, not a reason
   * for the 5-minute check to stop running.
   *
   * `settlementAssetsOn` is shared with `PublicReservesApiModule`, so
   * the set this job reconciles and the set `/reserves` publishes cannot drift
   * — a page publishing a chain nobody reconciles is the failure two
   * derivations would be one forgotten edit away from.
   */
  private assets(): AssetId[] {
    return this.chains
      .enabledChains()
      .flatMap((chainId) => settlementAssetsOn(chainId))
      .filter((asset, index, all) => all.indexOf(asset) === index);
  }
}
