import { EvmMinimumStakeReader } from '@modules/chains/evm/evm-minimum-stake-reader.service';
import { ChainId } from '@modules/chains/ports/caip.types';

/** BUG-OPS-CORE-02: the economics panel's minimum stake is the contract's own `params()`. */
describe('EvmMinimumStakeReader', () => {
  const CHAIN = 'eip155:46630' as ChainId;
  const deployment = {
    chainId: CHAIN,
    config: '0x00000000000000000000000000000000000000c0',
    stake: '0x00000000000000000000000000000000000000c1',
    escrow: '0x00000000000000000000000000000000000000c2',
    asset: '0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac',
  };

  it('reads params().minimumStake from the config contract, in the settlement asset', async () => {
    const readContract = jest.fn(async () => ({ minimumStake: 100_000_000n }));
    const reader = new EvmMinimumStakeReader(
      new Map([[CHAIN, { readContract }]]) as never,
      new Map([[CHAIN, deployment]]) as never,
    );

    const [entry] = await reader.readMinimumStakes();

    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '0x00000000000000000000000000000000000000C0',
        functionName: 'params',
      }),
    );
    expect(entry.chainId).toBe(CHAIN);
    expect(entry.minimumStake).toMatchObject({
      amount: '100000000',
      asset: `${CHAIN}/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac`,
      decimals: 6,
    });
  });

  it('skips a deployment with no client', async () => {
    const reader = new EvmMinimumStakeReader(
      new Map() as never,
      new Map([[CHAIN, deployment]]) as never,
    );
    expect(await reader.readMinimumStakes()).toEqual([]);
  });
});
