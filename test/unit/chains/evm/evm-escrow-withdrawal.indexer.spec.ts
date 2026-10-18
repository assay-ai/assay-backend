import {
  EscrowWithdrawalLog,
  EvmEscrowWithdrawalClient,
  EvmEscrowWithdrawalIndexer,
} from '@modules/chains/evm/evm-escrow-withdrawal.indexer';
import { EvmDeployment } from '@modules/chains/evm/evm.constants';
import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';

const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET as ChainId;
const ESCROW = '0x60aBdb81796322b1bA6674068a3861309a9f8D37' as const;

function build(
  options: {
    cursor?: bigint | null;
    head?: bigint;
    getBlockFails?: boolean;
    inserted?: unknown[];
    ownerFails?: boolean;
    blockTime?: bigint;
    /** A block's timestamp by number; may throw. */
    timeOf?: (blockNumber: bigint) => bigint;
  } = {},
) {
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
      : jest.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
          timestamp: options.timeOf
            ? options.timeOf(blockNumber)
            : (options.blockTime ?? BigInt(Math.floor(Date.now() / 1000))),
        })),
  };
  const events = {
    findCursor: jest.fn(async () => (options.cursor === undefined ? 99n : options.cursor)),
    applyIndexedRange: jest.fn(async () => options.inserted ?? []),
    recordError: jest.fn(async () => undefined),
    escrowOwner: options.ownerFails
      ? jest.fn(async () => {
          throw new Error('db down');
        })
      : jest.fn(async () => ({ organizationId: 'org-1', accountId: 'acc', assetId: 'asset' })),
  };
  const alerts = { emit: jest.fn(async () => undefined) };
  const audit = { recordAfterCommit: jest.fn(async () => undefined) };
  const indexer = new EvmEscrowWithdrawalIndexer(
    new Map([[CHAIN, client]]),
    new Map([[CHAIN, { escrow: ESCROW } as unknown as EvmDeployment]]),
    [CHAIN],
    events as never,
    alerts as never,
    audit as never,
    { fromBlock: new Map(), confirmations: 12 },
  );
  return { indexer, client, events, alerts, audit };
}

describe('EvmEscrowWithdrawalIndexer (B7)', () => {
  it('reads the escrow from the cursor to the safe head, and stores a zero request as a cancel', async () => {
    const { indexer, client, events } = build();

    await indexer.tick();

    expect(client.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ address: ESCROW, fromBlock: 100n, toBlock: 188n }),
    );
    expect(events.applyIndexedRange).toHaveBeenCalledWith(CHAIN, 188n, [
      expect.objectContaining({
        kind: 'CANCELLED',
        buyerAddress: '0xabc0000000000000000000000000000000000001',
        amount: 0n,
        availableAt: null,
      }),
    ]);
  });

  it('does not move the cursor when a block cannot be read, and records and alerts it', async () => {
    const { indexer, events, alerts } = build({ getBlockFails: true });

    await indexer.tick();

    expect(events.applyIndexedRange).not.toHaveBeenCalled();
    expect(events.recordError).toHaveBeenCalledWith(
      CHAIN,
      'the chain or the database could not be read',
    );
    expect(alerts.emit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'escrow_withdrawal_index_failing', dedupeKey: CHAIN }),
    );
  });

  const claim = {
    chainId: CHAIN,
    buyerAddress: '0xabc0000000000000000000000000000000000001',
    kind: 'WITHDRAWN',
    amount: 5n,
    requested: 5n,
    availableAt: null,
    blockNumber: 105n,
    logIndex: 2,
    transactionHash: '0x1',
    blockTime: new Date(),
  };

  it('writes the claim audit after the range is committed', async () => {
    const { indexer, events, audit } = build({ inserted: [claim] });

    await indexer.tick();

    expect(events.applyIndexedRange.mock.invocationCallOrder[0]).toBeLessThan(
      audit.recordAfterCommit.mock.invocationCallOrder[0],
    );
    expect(audit.recordAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', action: 'withdrawal.claimed' }),
    );
  });

  it('a failing audit lookup never holds the history back', async () => {
    const { indexer, events, audit, alerts } = build({ inserted: [claim], ownerFails: true });

    await indexer.tick();

    expect(events.applyIndexedRange).toHaveBeenCalledTimes(1);
    expect(audit.recordAfterCommit).not.toHaveBeenCalled();
    expect(events.recordError).not.toHaveBeenCalled();
    expect(alerts.emit).not.toHaveBeenCalled();
  });

  it('alerts once per incident when the index trails the head block by over an hour of chain time', async () => {
    // One second a block: indexed through 10,099, head at 30,000.
    const { indexer, alerts, events } = build({ head: 30_000n, timeOf: (n) => n });

    await indexer.tick();

    expect(events.applyIndexedRange).toHaveBeenCalledWith(CHAIN, 10_099n, expect.anything());
    expect(alerts.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'escrow_withdrawal_index_lagging',
        aggregation: 'ONCE_PER_INCIDENT',
      }),
    );
  });

  it('an idle chain at the safe head is not lagging, however old its last block', async () => {
    const { indexer, alerts } = build({ blockTime: BigInt(Math.floor(Date.now() / 1000) - 7_200) });

    await indexer.tick();

    expect(alerts.emit).not.toHaveBeenCalled();
  });

  it('a failed lag read is neither an index failure nor an alert', async () => {
    const { indexer, alerts, events } = build({
      head: 30_000n,
      timeOf: (n) => {
        if (n === 30_000n) throw new Error('rpc down');
        return n;
      },
    });

    await indexer.tick();

    expect(events.applyIndexedRange).toHaveBeenCalledTimes(1);
    expect(events.recordError).not.toHaveBeenCalled();
    expect(alerts.emit).not.toHaveBeenCalled();
  });

  it('reads nothing when the cursor is already at the safe head', async () => {
    const { indexer, client } = build({ cursor: 188n });

    await indexer.tick();

    expect(client.getContractEvents).not.toHaveBeenCalled();
  });
});
