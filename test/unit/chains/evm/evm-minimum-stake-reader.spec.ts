import { EvmMinimumStakeReader } from '@modules/chains/evm/evm-minimum-stake-reader.service';
import { ChainId } from '@modules/chains/ports/caip.types';

/** BUG-OPS-CORE-02: the economics panel's minimum stake is the contract's own `params()`. */
describe('EvmMinimumStakeReader', () => {
  const CHAIN = 'eip155:46630' as ChainId;
  const OTHER = 'eip155:1' as ChainId;
  const deploymentOf = (chainId: ChainId) => ({
    chainId,
    config: '0x00000000000000000000000000000000000000c0',
    stake: '0x00000000000000000000000000000000000000c1',
    escrow: '0x00000000000000000000000000000000000000c2',
    asset: '0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac',
  });

  afterEach(() => jest.useRealTimers());

  it('reads params().minimumStake from the config contract, in the settlement asset', async () => {
    const readContract = jest.fn(async () => ({ minimumStake: 100_000_000n }));
    const reader = new EvmMinimumStakeReader(
      new Map([[CHAIN, { readContract }]]) as never,
      new Map([[CHAIN, deploymentOf(CHAIN)]]) as never,
    );

    const [entry] = await reader.readMinimumStakes({ timeoutMs: 2_000 });

    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '0x00000000000000000000000000000000000000C0',
        functionName: 'params',
      }),
    );
    expect(entry.chainId).toBe(CHAIN);
    expect(entry.failure).toBeNull();
    expect(entry.minimumStake).toMatchObject({
      amount: '100000000',
      asset: `${CHAIN}/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac`,
      decimals: 6,
    });
  });

  it('gives up on a chain that never answers after the budget, and keeps the one that did', async () => {
    jest.useFakeTimers();
    const hung = { readContract: jest.fn(() => new Promise(() => undefined)) };
    const fine = { readContract: jest.fn(async () => ({ minimumStake: 100_000_000n })) };
    const reader = new EvmMinimumStakeReader(
      new Map([
        [CHAIN, fine],
        [OTHER, hung],
      ]) as never,
      new Map([
        [CHAIN, deploymentOf(CHAIN)],
        [OTHER, deploymentOf(OTHER)],
      ]) as never,
    );

    const pending = reader.readMinimumStakes({ timeoutMs: 2_000 });
    await jest.advanceTimersByTimeAsync(2_000);
    const readings = await pending;

    expect(readings.map((r) => [r.chainId, r.failure])).toEqual([
      [CHAIN, null],
      [OTHER, 'TIMEOUT'],
    ]);
    expect(readings[1].minimumStake).toBeNull();
  });

  it('reports a failed read as UNREADABLE, without the error text', async () => {
    const reader = new EvmMinimumStakeReader(
      new Map([
        [
          CHAIN,
          {
            readContract: jest.fn(async () =>
              Promise.reject(new Error('ECONNREFUSED 10.0.0.1:8545')),
            ),
          },
        ],
      ]) as never,
      new Map([[CHAIN, deploymentOf(CHAIN)]]) as never,
    );

    const readings = await reader.readMinimumStakes({ timeoutMs: 2_000 });

    expect(readings).toEqual([{ chainId: CHAIN, minimumStake: null, failure: 'UNREADABLE' }]);
  });

  it('skips a deployment with no client', async () => {
    const reader = new EvmMinimumStakeReader(
      new Map() as never,
      new Map([[CHAIN, deploymentOf(CHAIN)]]) as never,
    );
    expect(await reader.readMinimumStakes({ timeoutMs: 2_000 })).toEqual([]);
  });
});
