import { getAddress } from 'viem';

import { getAssetMetadata } from '../ports/asset-registry';
import { ChainId, toAssetId } from '../ports/caip.types';
import { MinimumStakeReaderPort } from '../ports/minimum-stake-reader.port';
import { Money } from '../ports/money.types';
import { MoneyUtil } from '@shared/utils/money.util';
import { ASSAY_CONFIG_ABI } from './abi/assay.abi';
import { EvmReaderClient } from './evm-escrow-balance-reader.service';
import { EvmDeployment } from './evm.constants';

/**
 * `params().minimumStake` of every EVM deployment that has a client, in the
 * deployment's settlement asset. A failed read rejects: the caller decides
 * how to show an unreadable chain.
 */
export class EvmMinimumStakeReader implements MinimumStakeReaderPort {
  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmReaderClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
  ) {}

  async readMinimumStakes(): Promise<{ chainId: ChainId; minimumStake: Money }[]> {
    const readable = [...this.deployments.values()].filter((deployment) =>
      this.clients.has(deployment.chainId),
    );
    return Promise.all(
      readable.map(async (deployment) => {
        const params = (await this.clients.get(deployment.chainId)!.readContract({
          address: getAddress(deployment.config),
          abi: ASSAY_CONFIG_ABI,
          functionName: 'params',
          args: [],
        })) as { minimumStake: bigint };
        const asset = toAssetId(deployment.chainId, 'erc20', getAddress(deployment.asset));
        return {
          chainId: deployment.chainId,
          minimumStake: MoneyUtil.of(
            BigInt(params.minimumStake).toString(),
            asset,
            getAssetMetadata(asset).decimals,
          ),
        };
      }),
    );
  }
}
