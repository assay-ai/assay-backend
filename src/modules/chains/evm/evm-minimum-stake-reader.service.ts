import { Logger } from '@nestjs/common';
import { getAddress } from 'viem';

import { getAssetMetadata } from '../ports/asset-registry';
import { ChainId, toAssetId } from '../ports/caip.types';
import { MinimumStakeReaderPort, MinimumStakeReading } from '../ports/minimum-stake-reader.port';
import { Money } from '../ports/money.types';
import { MoneyUtil } from '@shared/utils/money.util';
import { ASSAY_CONFIG_ABI } from './abi/assay.abi';
import { EvmReaderClient } from './evm-escrow-balance-reader.service';
import { EvmDeployment } from './evm.constants';

const TIMED_OUT = Symbol('timed out');

/**
 * `params().minimumStake` of every EVM deployment that has a client, in the
 * deployment's settlement asset. Each chain is read under its own time budget
 * and failure: a node that accepts the connection and never answers costs the
 * caller `timeoutMs`, not the egress client's 30 s, and the chains that did
 * answer keep their values.
 */
export class EvmMinimumStakeReader implements MinimumStakeReaderPort {
  private readonly logger = new Logger(EvmMinimumStakeReader.name);

  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmReaderClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
  ) {}

  async readMinimumStakes(options: { timeoutMs: number }): Promise<MinimumStakeReading[]> {
    const readable = [...this.deployments.values()].filter((deployment) =>
      this.clients.has(deployment.chainId),
    );
    return Promise.all(readable.map((deployment) => this.readOne(deployment, options.timeoutMs)));
  }

  private async readOne(
    deployment: EvmDeployment,
    timeoutMs: number,
  ): Promise<MinimumStakeReading> {
    const { chainId } = deployment;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    try {
      const outcome = await Promise.race([this.fetch(deployment), timeout]);
      if (outcome === TIMED_OUT) {
        this.logger.warn(`minimum stake read on ${chainId}: no answer within ${timeoutMs} ms`);
        return { chainId, minimumStake: null, failure: 'TIMEOUT' };
      }
      return { chainId, minimumStake: outcome, failure: null };
    } catch (error) {
      this.logger.warn(
        `minimum stake read on ${chainId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { chainId, minimumStake: null, failure: 'UNREADABLE' };
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetch(deployment: EvmDeployment): Promise<Money> {
    const params = (await this.clients.get(deployment.chainId)!.readContract({
      address: getAddress(deployment.config),
      abi: ASSAY_CONFIG_ABI,
      functionName: 'params',
      args: [],
    })) as { minimumStake: bigint };
    const asset = toAssetId(deployment.chainId, 'erc20', getAddress(deployment.asset));
    return MoneyUtil.of(
      BigInt(params.minimumStake).toString(),
      asset,
      getAssetMetadata(asset).decimals,
    );
  }
}
