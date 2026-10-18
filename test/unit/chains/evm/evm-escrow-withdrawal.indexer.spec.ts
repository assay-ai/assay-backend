import {
  EscrowWithdrawalLog,
  EvmEscrowWithdrawalClient,
  EvmEscrowWithdrawalIndexer,
} from '@modules/chains/evm/evm-escrow-withdrawal.indexer';
import { EvmDeployment } from '@modules/chains/evm/evm.constants';
import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';

const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET as ChainId;
const ESCROW = '0x60aBdb81796322b1bA6674068a3861309a9f8D37' as const;

function build(options: { cursor?: bigint | null; head?: bigint; getBlockFails?: boolean } = {}) {
  const logs: EscrowWithdrawalLog[] = [
    {
      eventName: 'WithdrawRequested',
      args: { buyer: '0xAbC0000000000000000000000000000000000001', amount: 0n, availableAt: 0n },
      blockNumber: 105n,
      logIndex: 2,
      transactionHash: `0x${'1'.repeat(64)}`,
    },
  ];
  const client: EvmEscrowWithdrawalClient = {
    getBlockNumber: jest.fn(async () => options.head ?? 200n),
    getContractEvents: jest.fn(async () => logs),
    getBlock: options.getBlockFails
      ? jest.fn(async () => {
          throw new Error('rpc down');
        })
      : jest.fn(async () => ({ timestamp: 1_800_000_000n })),
  };
  const events = {
    findCursor: jest.fn(async () => (options.cursor === undefined ? 99n : options.cursor)),
    applyIndexedRange: jest.fn(async () => []),
    escrowOwner: jest.fn(),
  };
  const indexer = new EvmEscrowWithdrawalIndexer(
    new Map([[CHAIN, client]]),
    new Map([[CHAIN, { escrow: ESCROW } as unknown as EvmDeployment]]),
    [CHAIN],
    events as never,
    null,
    { fromBlock: new Map(), confirmations: 12 },
  );
  return { indexer, client, events };
}

describe('EvmEscrowWithdrawalIndexer (B7)', () => {
  it('reads the escrow from the cursor to the safe head, and stores a zero request as a cancel', async () => {
    const { indexer, client, events } = build();

    await indexer.tick();

    expect(client.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ address: ESCROW, fromBlock: 100n, toBlock: 188n }),
    );
    expect(events.applyIndexedRange).toHaveBeenCalledWith(
      CHAIN,
      188n,
      [
        expect.objectContaining({
          kind: 'CANCELLED',
          buyerAddress: '0xabc0000000000000000000000000000000000001',
          amount: 0n,
          availableAt: null,
          blockTime: new Date(1_800_000_000_000),
        }),
      ],
      expect.any(Function),
    );
  });

  it('does not move the cursor when a block cannot be read', async () => {
    const { indexer, events } = build({ getBlockFails: true });

    await indexer.tick();

    expect(events.applyIndexedRange).not.toHaveBeenCalled();
  });

  it('reads nothing when the cursor is already at the safe head', async () => {
    const { indexer, client } = build({ cursor: 188n });

    await indexer.tick();

    expect(client.getContractEvents).not.toHaveBeenCalled();
  });
});
