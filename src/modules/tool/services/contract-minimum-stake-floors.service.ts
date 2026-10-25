import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { ChainId } from '@modules/chains/ports/caip.types';
import {
  CHAIN_PARAMS,
  ChainParams,
  ChainParamsPort,
} from '@modules/chains/ports/chain-params.port';
import { loadMinimumStakeByChain } from '@modules/provider/services/provider-stake.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { MinimumStakeByChain, MinimumStakeParameters } from '../domain/routing/routing.types';

/**
 * The routing stake floor per chain, following the settlement contract's own
 * `params().minimumStake` (the on-chain params cache, `CHAIN_PARAMS`), so
 * routing and the contract agree.
 *
 * ## Never slow, chain first
 *
 * - The gate never waits for a chain: `byChain` is a plain in-memory map the
 *   router reads synchronously, updated whenever the params cache reads a new
 *   value (at boot, every 5 minutes, and at once after a config-change event).
 * - A chain the cache has read follows the contract in BOTH directions: a
 *   contract minimum below `PROVIDER_MINIMUM_STAKE_FLOOR` is used as well.
 * - A chain the cache never read keeps the configured floor
 *   (`PROVIDER_MINIMUM_STAKE_FLOOR`), the fallback. A chain with no floor in
 *   config gets none from here either.
 * - The price multiple is the configured one; only the floor amount moves.
 */
export class ContractMinimumStakeFloors implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContractMinimumStakeFloors.name);
  private readonly live: Map<ChainId, MinimumStakeParameters>;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly configured: MinimumStakeByChain,
    private readonly params: ChainParamsPort | null,
  ) {
    this.live = new Map(configured);
  }

  /** The map the router and the write-time gates read. Same object for its whole life. */
  get byChain(): MinimumStakeByChain {
    return this.live;
  }

  onModuleInit(): void {
    if (!this.params) return;
    this.applyAll();
    this.unsubscribe = this.params.subscribe((reading) => this.apply(reading));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Read every chain again and apply the result. Never throws. */
  async refresh(): Promise<void> {
    if (!this.params) return;
    await this.params.refresh();
    this.applyAll();
  }

  private applyAll(): void {
    for (const chainId of this.configured.keys()) {
      const reading = this.params?.current(chainId);
      if (reading) this.apply(reading);
    }
  }

  private apply(reading: ChainParams): void {
    const configured = this.configured.get(reading.chainId);
    if (!configured) return;
    if (reading.source !== 'chain' || reading.minimumStake === null) {
      this.set(reading.chainId, configured);
      return;
    }

    const read = reading.minimumStake;
    // The same token, maybe with another address case (the reader checksums):
    // re-tag the amount with the floor's own asset so the two compare.
    if (
      read.asset.toLowerCase() !== configured.floor.asset.toLowerCase() ||
      read.decimals !== configured.floor.decimals
    ) {
      this.logger.warn(
        `minimum stake on ${reading.chainId} is in ${read.asset}, the routing floor in ` +
          `${configured.floor.asset}; the routing floor stays as it was`,
      );
      return;
    }
    this.set(reading.chainId, {
      ...configured,
      floor: MoneyUtil.of(read.amount, configured.floor.asset, configured.floor.decimals),
    });
  }

  private set(chainId: ChainId, next: MinimumStakeParameters): void {
    if (this.live.get(chainId)?.floor.amount !== next.floor.amount) {
      this.logger.log(`routing minimum stake on ${chainId} is now ${next.floor.amount}`);
    }
    this.live.set(chainId, next);
  }
}

/**
 * The Nest provider for {@link ContractMinimumStakeFloors}: config floors per
 * enabled chain, replaced by the contract's value once the params cache read it. Used by
 * `ToolModule` (routing, the binding gates) and by the scheduler's stake
 * monitor module, which does not import `ToolModule`.
 */
export const CONTRACT_MINIMUM_STAKE_FLOORS_PROVIDER = {
  provide: ContractMinimumStakeFloors,
  useFactory: (
    config: ConfigService,
    enabled: readonly ChainId[],
    params: ChainParamsPort | null,
  ) => new ContractMinimumStakeFloors(loadMinimumStakeByChain(config, enabled), params ?? null),
  inject: [ConfigService, ENABLED_CHAINS, { token: CHAIN_PARAMS, optional: true }],
};
