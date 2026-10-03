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
 * replica. **There is deliberately no lock**, for the same reason
 * `ReconciliationJob` has none: two passes racing the same buyer's vouchers
 * would each pay a transaction fee and one of them would lose to
 * `VoucherSeqNotIncreasing`, which is money rather than a correctness problem,
 * and the single-instance rule is what actually prevents it.
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

  @Cron(VOUCHER_REDEMPTION_CRON)
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
