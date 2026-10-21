import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { ChainId } from '@modules/chains/ports/caip.types';
import {
  MINIMUM_STAKE_READER,
  MinimumStakeReaderPort,
  MinimumStakeReading,
} from '@modules/chains/ports/minimum-stake-reader.port';
import { loadMinimumStakeByChain } from '@modules/provider/services/provider-stake.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { MinimumStakeByChain, MinimumStakeParameters } from '../domain/routing/routing.types';

/** Per chain, the contract read waits this long (the economics panel's budget too). */
export const CONTRACT_MINIMUM_STAKE_READ_TIMEOUT_MS = 2_000;

/** How often the contract minimum is read again in the background. */
export const CONTRACT_MINIMUM_STAKE_REFRESH_MS = 5 * 60 * 1000;

/**
 * The routing stake floor per chain, following the settlement contract's own
 * `params().minimumStake` (the number the operator economics panel shows), so
 * routing and the contract agree.
 *
 * ## Never slow, never open
 *
 * - The gate never waits for a chain: `byChain` is a plain in-memory map the
 *   router reads synchronously. It is read once before the module finishes
 *   starting (each chain bounded by
 *   {@link CONTRACT_MINIMUM_STAKE_READ_TIMEOUT_MS}, in parallel) and then
 *   every {@link CONTRACT_MINIMUM_STAKE_REFRESH_MS} in the background.
 * - A chain that cannot be read keeps what it had: its last contract reading,
 *   or the configured floor (`PROVIDER_MINIMUM_STAKE_FLOOR`) when it was never
 *   read. A chain with no floor in config gets none from here either.
 * - The floor never drops below the configured one: a contract minimum below
 *   `PROVIDER_MINIMUM_STAKE_FLOOR` leaves the configured floor in place (and
 *   says so in the log). Only a stricter contract raises it.
 * - The price multiple is the configured one; only the floor amount moves.
 */
export class ContractMinimumStakeFloors implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContractMinimumStakeFloors.name);
  private readonly live: Map<ChainId, MinimumStakeParameters>;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly configured: MinimumStakeByChain,
    private readonly reader: MinimumStakeReaderPort | null,
    private readonly options: { readonly refreshMs?: number; readonly timeoutMs?: number } = {},
  ) {
    this.live = new Map(configured);
  }

  /** The map the router and the write-time gates read. Same object for its whole life. */
  get byChain(): MinimumStakeByChain {
    return this.live;
  }

  async onModuleInit(): Promise<void> {
    await this.refresh();
    if (!this.reader) return;
    this.timer = setInterval(
      () => void this.refresh(),
      this.options.refreshMs ?? CONTRACT_MINIMUM_STAKE_REFRESH_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Read every chain once and apply what answered. Never throws; one run at a time. */
  refresh(): Promise<void> {
    if (!this.reader) return Promise.resolve();
    if (!this.running) {
      this.running = this.readAndApply(this.reader).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async readAndApply(reader: MinimumStakeReaderPort): Promise<void> {
    let readings: readonly MinimumStakeReading[];
    try {
      readings = await reader.readMinimumStakes({
        timeoutMs: this.options.timeoutMs ?? CONTRACT_MINIMUM_STAKE_READ_TIMEOUT_MS,
      });
    } catch (error) {
      this.logger.warn(
        `minimum stake refresh failed; the routing floors stay as they were: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    for (const reading of readings) this.apply(reading);
  }

  private apply(reading: MinimumStakeReading): void {
    const configured = this.configured.get(reading.chainId);
    if (!configured || reading.minimumStake === null) return;

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
    const onChain = MoneyUtil.of(read.amount, configured.floor.asset, configured.floor.decimals);

    const floor = MoneyUtil.greaterThan(onChain, configured.floor) ? onChain : configured.floor;
    if (floor === configured.floor && MoneyUtil.greaterThan(configured.floor, onChain)) {
      this.logger.warn(
        `minimum stake on ${reading.chainId}: the contract asks ${onChain.amount}, below the ` +
          `configured floor ${configured.floor.amount}; routing keeps the configured floor`,
      );
    }
    const current = this.live.get(reading.chainId);
    if (current?.floor.amount !== floor.amount) {
      this.logger.log(`routing minimum stake on ${reading.chainId} is now ${floor.amount}`);
    }
    this.live.set(reading.chainId, { ...configured, floor });
  }
}

/**
 * The Nest provider for {@link ContractMinimumStakeFloors}: config floors per
 * enabled chain, raised by the contract reader when one is wired. Used by
 * `ToolModule` (routing, the binding gates) and by the scheduler's stake
 * monitor module, which does not import `ToolModule`.
 */
export const CONTRACT_MINIMUM_STAKE_FLOORS_PROVIDER = {
  provide: ContractMinimumStakeFloors,
  useFactory: (
    config: ConfigService,
    enabled: readonly ChainId[],
    reader: MinimumStakeReaderPort | null,
  ) => new ContractMinimumStakeFloors(loadMinimumStakeByChain(config, enabled), reader ?? null),
  inject: [ConfigService, ENABLED_CHAINS, { token: MINIMUM_STAKE_READER, optional: true }],
};
