import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ASSET_IDS, getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { AssetId } from '@modules/chains/ports/caip.types';

import { VOUCHER_REDEMPTION_CRON } from '../constants/voucher-redemption.constants';
import { VoucherRedemptionService } from '../services/voucher-redemption.service';

/**
 * The cron wrapper around `VoucherRedemptionService.run`.
 *
 * Registered only in `PaymentSchedulerModule`, which only the scheduler process
 * imports — the scheduler is a single instance by design (`docs/architecture.md`
 * §Scaling Design), so this fires once per deployment rather than once per API
 * replica. **Ticks never overlap** (`waitForCompletion`): one pass can outlast
 * the minute — a receipt waits up to 180 s — and a second pass over the same
 * rows would lose to `VoucherSeqNotIncreasing` (`VoucherSeqUsed` on eip155) on a voucher the first one had
 * just redeemed. That is not a fee: the loser would close it as buyer debt and
 * charge the buyer a second time (review 2026-10-15 P-1). A tick that comes due while
 * a pass runs is skipped, and the next one after it finds the rows. Across
 * processes the single-instance rule is what prevents it, and
 * `VoucherRedemptionService` checks the chain for the voucher's own
 * transaction before it closes anything as the second line.
 *
 * The handler cannot throw: `run` catches per hold, and the loop below catches
 * anything left so one asset's problem cannot stop the next asset being
 * redeemed. A cron handler that rejects is logged by Nest and then forgotten —
 * and forgetting here means a buyer's money stays held and a provider stays
 * unpaid.
 */
@Injectable()
export class VoucherRedemptionJob {
  private readonly logger = new Logger(VoucherRedemptionJob.name);

  constructor(
    private readonly redemption: VoucherRedemptionService,
    private readonly chains: ChainAdapterRegistry,
  ) {}

  @Cron(VOUCHER_REDEMPTION_CRON, { waitForCompletion: true })
  async handleRedemption(): Promise<void> {
    for (const asset of this.assets()) {
      try {
        await this.redemption.run(asset);
      } catch (error) {
        this.logger.error(
          `Voucher redemption for ${asset} threw past its own error handling: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * The assets an escrow can hold — derived from the enabled chains rather than
   * configured separately, exactly as `ReconciliationJob.assets` is. A second
   * env var would be a second place to forget a chain, and forgetting here
   * means a rail whose holds nobody redeems.
   */
  private assets(): AssetId[] {
    const usdc = Object.values(ASSET_IDS);

    return this.chains
      .enabledChains()
      .flatMap((chainId) =>
        usdc.filter((asset) => {
          try {
            return getAssetMetadata(asset).chainId === chainId;
          } catch {
            return false;
          }
        }),
      )
      .filter((asset, index, all) => all.indexOf(asset) === index);
  }
}
