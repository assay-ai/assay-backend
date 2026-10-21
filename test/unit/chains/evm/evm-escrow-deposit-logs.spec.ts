import { AccountId, AssetId, ChainId } from '@modules/chains/ports/caip.types';
import {
  DEFAULT_DEPOSIT_LOOKBACK_BLOCKS,
  DEPOSIT_LOG_CHUNK,
  EvmEscrowDepositLogs,
  parseDepositLookbackBlocks,
} from '@modules/chains/evm/evm-escrow-deposit-logs.service';

const CHAIN = 'eip155:46630' as ChainId;
const ASSET = `${CHAIN}/erc20:0x0000000000000000000000000000000000000001` as AssetId;
const ESCROW = '0x00000000000000000000000000000000000000e5';
const BUYER = '0x18103e0000000000000000000000000000007296';

/** A2: the reconciler's read of the deposits into one escrow. Read-only. */
describe('EvmEscrowDepositLogs', () => {
  function build(head: bigint, lookback = 5_000n) {
    const getContractEvents = jest.fn(async (args: { fromBlock: bigint }) =>
      args.fromBlock === head - lookback + 1n
        ? [
            {
              args: { amount: 5_000_000n },
              blockNumber: args.fromBlock + 3n,
              transactionHash: '0x473E1319' as `0x${string}`,
            },
            { args: {}, blockNumber: null, transactionHash: null },
          ]
        : [],
    );
    const client = { getBlockNumber: jest.fn(async () => head), getContractEvents };
    const logs = new EvmEscrowDepositLogs(
      new Map([[CHAIN, client]]) as never,
      new Map([[CHAIN, { escrow: ESCROW }]]) as never,
      lookback,
    );
    return { logs, getContractEvents };
  }

  it("reads only this buyer's Deposited events over the window, in chunks", async () => {
    const { logs, getContractEvents } = build(100_000n);

    const found = await logs.depositsTo(ASSET, `${CHAIN}:${BUYER}` as AccountId);

    expect(found).toEqual({
      logs: [{ txHash: '0x473e1319', amount: 5_000_000n, blockNumber: 95_004n }],
      fromBlock: 95_001n,
      toBlock: 100_000n,
    });
    expect(getContractEvents).toHaveBeenCalledTimes(Math.ceil(5_000 / Number(DEPOSIT_LOG_CHUNK)));
    expect(getContractEvents.mock.calls[0][0]).toMatchObject({
      eventName: 'Deposited',
      fromBlock: 95_001n,
      toBlock: 95_001n + DEPOSIT_LOG_CHUNK - 1n,
    });
    const last = getContractEvents.mock.calls.at(-1)![0] as unknown as { toBlock: bigint };
    expect(last.toBlock).toBe(100_000n);
    expect(
      (
        getContractEvents.mock.calls[0][0] as unknown as { args: { buyer: string } }
      ).args.buyer.toLowerCase(),
    ).toBe(BUYER);
  });

  it('answers null, not an empty list, off eip155 or without a deployment', async () => {
    const { logs } = build(10n);
    await expect(
      logs.depositsTo('solana:x/token:y' as AssetId, 'solana:x:z' as AccountId),
    ).resolves.toBeNull();
    await expect(
      logs.depositsTo(
        'eip155:1/erc20:0x0000000000000000000000000000000000000001' as AssetId,
        `eip155:1:${BUYER}` as AccountId,
      ),
    ).resolves.toBeNull();
  });

  it('reads the lookback from the environment, else the default', () => {
    expect(parseDepositLookbackBlocks('200000')).toBe(200_000n);
    expect(parseDepositLookbackBlocks(undefined)).toBe(DEFAULT_DEPOSIT_LOOKBACK_BLOCKS);
    expect(parseDepositLookbackBlocks('-1')).toBe(DEFAULT_DEPOSIT_LOOKBACK_BLOCKS);
  });
});
