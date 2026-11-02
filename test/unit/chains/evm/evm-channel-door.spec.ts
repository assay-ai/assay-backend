import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  pad,
  parseAbi,
  toEventSelector,
  toFunctionSelector,
} from 'viem';

import { EvmChannelDoor } from '@modules/chains/evm/evm-channel-door.service';
import { CHANNEL_DOOR_ABI } from '@modules/chains/evm/abi/channel-door.abi';

const CHAIN = 'eip155:46630' as never;
const ASSET = 'eip155:46630/erc20:0x5FbDB2315678afecb367f032d93F642f64180aa3' as never;
const ESCROW = getAddress(`0x${'e5'.repeat(20)}`);
const PAYER = getAddress(`0x${'aa'.repeat(20)}`);
const DELEGATE = getAddress(`0x${'dd'.repeat(20)}`);
const PROVIDER = getAddress(`0x${'bb'.repeat(20)}`);
const REDEEMER = getAddress(`0x${'90'.repeat(20)}`);
const ZERO = '0x0000000000000000000000000000000000000000' as const;
const NOW = 1_800_000_000;

const CAPS_HELD = parseAbi([
  'event CapsHeld(address indexed payer, address indexed delegate, uint64 maxVoucherAmount, uint64 maxPerWindow, uint64 until)',
]);

function capsHeld(delegate: `0x${string}`, until: number) {
  return {
    address: ESCROW,
    topics: encodeEventTopics({
      abi: CAPS_HELD,
      eventName: 'CapsHeld',
      args: { payer: PAYER, delegate },
    }),
    data: encodeAbiParameters(
      [{ type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' }],
      [1n, 2n, BigInt(until)],
    ),
  };
}

function door(client: Record<string, unknown>, freeze: Record<string, string> = {}) {
  return new EvmChannelDoor(
    new Map([[CHAIN, client as never]]),
    new Map([
      [
        CHAIN,
        {
          chainId: CHAIN,
          config: `0x${'c0'.repeat(20)}`,
          stake: `0x${'57'.repeat(20)}`,
          escrow: ESCROW,
          asset: `0x${'a5'.repeat(20)}`,
        } as never,
      ],
    ]),
    { address: async () => `eip155:46630:${REDEEMER}` } as never,
    null,
    null,
    new Map(Object.entries(freeze)),
  );
}

describe('EvmChannelDoor — the inputs of D (v3 §5.4.3)', () => {
  const base = (delegation: Record<string, unknown>, logs: unknown[]) => ({
    getBlock: async () => ({ timestamp: BigInt(NOW) }),
    getBlockNumber: async () => 1_000n,
    getLogs: jest.fn(async () => logs),
    readContract: async (args: { functionName: string }) => {
      if (args.functionName === 'delegationOf')
        return { validUntil: BigInt(NOW + 86_400), revoked: false, ...delegation };
      throw new Error(`unexpected ${args.functionName}`);
    },
  });

  it('a live delegate: its validUntil, and the earliest running caps hold (escrow or delegate)', async () => {
    const client = base({}, [
      capsHeld(ZERO, NOW + 9_000),
      capsHeld(DELEGATE, NOW + 5_000),
      capsHeld(DELEGATE, NOW - 10),
    ]);
    const window = await door(client).signerWindow(ASSET, PAYER, DELEGATE);
    expect(window).toEqual({
      validUntil: NOW + 86_400,
      revoked: false,
      revokeGraceEndsAt: null,
      heldCapsEndAt: NOW + 5_000,
    });
    // The query names this payer and both the escrow's own and this delegate's holds.
    const call = client.getLogs.mock.calls[0] as unknown as [{ topics: unknown[] }];
    expect(call[0].topics[1]).toBe(pad(PAYER).toLowerCase());
    expect(call[0].topics[2]).toEqual([pad(ZERO), pad(DELEGATE).toLowerCase()]);
  });

  it('a revoked delegate: the grace end is its latest hold; none found means settle now', async () => {
    const graced = await door(
      base({ revoked: true }, [capsHeld(DELEGATE, NOW + 3_000)]),
    ).signerWindow(ASSET, PAYER, DELEGATE);
    expect(graced).toMatchObject({
      revoked: true,
      revokeGraceEndsAt: NOW + 3_000,
      heldCapsEndAt: null,
    });
    const lost = await door(base({ revoked: true }, [])).signerWindow(ASSET, PAYER, DELEGATE);
    expect(lost.revokeGraceEndsAt).toBe(NOW);
  });

  it('the payer’s own key: no validUntil, only the escrow’s caps hold', async () => {
    const window = await door(base({}, [capsHeld(ZERO, NOW + 1_000)])).signerWindow(
      ASSET,
      PAYER,
      PAYER,
    );
    expect(window).toEqual({
      validUntil: null,
      revoked: false,
      revokeGraceEndsAt: null,
      heldCapsEndAt: NOW + 1_000,
    });
  });
});

describe('EvmChannelDoor — caps-hold lookback in pages (ops F7)', () => {
  it('reads 200k blocks of CapsHeld in pages of at most 50k, keeping every hold', async () => {
    const getLogs = jest.fn(async ({ fromBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      fromBlock <= 400_000n ? [capsHeld(ZERO, NOW + 4_000)] : [capsHeld(ZERO, NOW + 2_000)],
    );
    const client = {
      getBlock: async () => ({ timestamp: BigInt(NOW) }),
      getBlockNumber: async () => 500_000n,
      getLogs,
      readContract: async () => {
        throw new Error('unexpected');
      },
    };
    const window = await door(client).signerWindow(ASSET, PAYER, PAYER);
    // The hold found only in an older page still counts (the latest running hold wins).
    expect(window.heldCapsEndAt).toBe(NOW + 4_000);
    const ranges = getLogs.mock.calls.map(([args]) => args.toBlock - args.fromBlock + 1n);
    expect(getLogs.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(ranges.every((r) => r <= 50_000n)).toBe(true);
    // Contiguous cover of [latest - 200k, latest].
    const froms = getLogs.mock.calls.map(([a]) => a.fromBlock);
    const tos = getLogs.mock.calls.map(([a]) => a.toBlock);
    expect(Math.max(...tos.map(Number))).toBe(500_000);
    expect(Math.min(...froms.map(Number))).toBe(300_000);
    expect(ranges.reduce((a, b) => a + b, 0n)).toBe(200_001n);
  });
});

describe('EvmChannelDoor — first foreign scan start (ops F13)', () => {
  it('starts at the recorded channel-door block when there is no cursor', async () => {
    const getLogs = jest.fn(async () => []);
    const client = {
      getBlockNumber: async () => 20_000n,
      getLogs,
      getTransaction: async () => ({}),
    };
    const d = new EvmChannelDoor(
      new Map([[CHAIN, client as never]]),
      new Map([
        [
          CHAIN,
          {
            chainId: CHAIN,
            config: `0x${'c0'.repeat(20)}`,
            stake: `0x${'57'.repeat(20)}`,
            escrow: ESCROW,
            asset: `0x${'a5'.repeat(20)}`,
            channelDoorFromBlock: 12_000n,
          } as never,
        ],
      ]),
      { address: async () => `eip155:46630:${REDEEMER}` } as never,
    );
    const scan = await d.foreignChannelTxs(ASSET, null, 5_000n);
    expect((getLogs.mock.calls[0] as unknown as [{ fromBlock: bigint }])[0].fromBlock).toBe(
      12_000n,
    );
    expect(scan.toBlock).toBe(17_000n);
  });
});

describe('EvmChannelDoor — provider risk', () => {
  const client = (stake: Record<string, bigint>, minimum: bigint, blocked = false) => ({
    readContract: async (args: { functionName: string }) => {
      if (args.functionName === 'stakeOf')
        return { bonded: 200n, unbonding: 0n, pendingSlash: 0n, ...stake };
      if (args.functionName === 'params') return { minimumStake: minimum };
      if (args.functionName === 'blocked') return blocked;
      throw new Error(args.functionName);
    },
  });

  it('none for a healthy provider', async () => {
    expect(await door(client({}, 100n)).providerRisk(ASSET, PROVIDER)).toEqual({
      unbonding: false,
      slashPending: false,
      nearFloor: false,
      blocked: false,
    });
  });

  it('unbonding, a pending slash, a raised minimum, a block', async () => {
    expect(await door(client({ unbonding: 1n }, 100n)).providerRisk(ASSET, PROVIDER)).toMatchObject(
      { unbonding: true },
    );
    expect(
      await door(client({ pendingSlash: 150n }, 100n)).providerRisk(ASSET, PROVIDER),
    ).toMatchObject({ slashPending: true, nearFloor: true });
    expect(await door(client({}, 180n)).providerRisk(ASSET, PROVIDER)).toMatchObject({
      nearFloor: true,
    });
    expect((await door(client({}, 100n, true)).providerRisk(ASSET, PROVIDER)).blocked).toBe(true);
  });
});

describe('EvmChannelDoor — the issuer-freeze probe is fail-safe', () => {
  it('no configured function: never probed, "not known frozen"', async () => {
    const readContract = jest.fn();
    expect(await door({ readContract }).isFrozen(ASSET, PROVIDER)).toBe(false);
    expect(readContract).not.toHaveBeenCalled();
  });

  it('a revert or an absent function reads not frozen; only a true answer is a freeze', async () => {
    const reverting = {
      readContract: async () => {
        throw new Error('execution reverted');
      },
    };
    expect(await door(reverting, { [CHAIN]: 'isBlacklisted' }).isFrozen(ASSET, PROVIDER)).toBe(
      false,
    );
    const frozen = { readContract: jest.fn(async () => true) };
    expect(await door(frozen, { [CHAIN]: 'isBlacklisted' }).isFrozen(ASSET, PROVIDER)).toBe(true);
    expect(frozen.readContract.mock.calls[0]).toEqual([
      expect.objectContaining({ functionName: 'isBlacklisted' }),
    ]);
  });
});

describe('EvmChannelDoor — channel transactions not sent by our redeemer (v3 §5.7)', () => {
  it('names a foreign settle, ignores our own, and advances a bounded window', async () => {
    const settled = {
      address: ESCROW,
      topics: encodeEventTopics({
        abi: CHANNEL_DOOR_ABI,
        eventName: 'ChannelSettled',
        args: { key: `0x${'0c'.repeat(32)}`, payer: PAYER, provider: PROVIDER },
      }),
      data: encodeAbiParameters(
        [
          { type: 'uint64' },
          { type: 'uint32' },
          { type: 'uint64' },
          { type: 'uint24' },
          { type: 'uint16' },
        ],
        [100n, 1, 100n, 500_001, 1_000],
      ),
    };
    const client = {
      getBlockNumber: async () => 20_000n,
      getLogs: jest.fn(async () => [
        { ...settled, transactionHash: '0xaaa', blockNumber: 19_990n },
        { ...settled, transactionHash: '0xbbb', blockNumber: 19_991n },
      ]),
      getTransaction: async ({ hash }: { hash: string }) => ({
        from: hash === '0xaaa' ? REDEEMER : PAYER,
      }),
    };
    const scan = await door(client).foreignChannelTxs(ASSET, null, 5_000n);
    expect(scan.toBlock).toBe(20_000n);
    expect(scan.foreign).toEqual([
      { txHash: '0xbbb', from: PAYER, events: ['ChannelSettled'], blockNumber: 19_991n },
    ]);
    expect((client.getLogs.mock.calls[0] as unknown as [{ fromBlock: bigint }])[0].fromBlock).toBe(
      15_000n,
    );
  });
});

describe('EvmChannelDoor — send outcomes (review 2026-10-31 H1/H2)', () => {
  const REF = {
    payer: PAYER,
    signer: PAYER,
    provider: PROVIDER,
    channelId: `0x${'5a'.repeat(32)}`,
  };
  function sendingDoor(
    sendCall: (call: any) => Promise<unknown>,
    client: Record<string, unknown> = {},
  ) {
    return new EvmChannelDoor(
      new Map([[CHAIN, client as never]]),
      new Map([
        [
          CHAIN,
          {
            chainId: CHAIN,
            config: `0x${'c0'.repeat(20)}`,
            stake: `0x${'57'.repeat(20)}`,
            escrow: ESCROW,
            asset: `0x${'a5'.repeat(20)}`,
          } as never,
        ],
      ]),
      { address: async () => `eip155:46630:${REDEEMER}`, sendCall } as never,
    );
  }

  it('hands the signed hash to beforeBroadcast before the broadcast', async () => {
    const recorded: string[] = [];
    const d = sendingDoor(async (call) => {
      await call.beforeBroadcast('0xfeed');
      return {
        hash: '0xfeed',
        status: 'SUCCESS',
        revertReason: null,
        gasUsed: 1n,
        blockNumber: 1n,
      };
    });
    await d.collect(ASSET, [REF as never], [0n], 'ORDINARY', {
      beforeBroadcast: async (hash) => void recorded.push(hash),
    });
    expect(recorded).toEqual(['0xfeed']);
  });

  it('a collect whose gas estimate failed still clears the per-payout gas floor (X-8)', async () => {
    // ChannelDoor: each payout needs gasleft() >= 300_000 * 64 / 63 + 50_000
    // inside the escrow's DELEGATECALL (another 64/63), plus the work itself.
    const limits: bigint[] = [];
    const d = sendingDoor(async (call) => {
      limits.push(call.gasLimit);
      return {
        hash: '0xfeed',
        status: 'SUCCESS',
        revertReason: null,
        gasUsed: 1n,
        blockNumber: 1n,
      };
    });
    await d.collect(ASSET, [REF as never], [0n], 'ORDINARY');
    const floor = (300_000n * 64n) / 63n + 50_000n;
    const insideDelegate = (floor * 64n + 62n) / 63n;
    // One provider payout + the treasury payout, ~26k per ERC-20 transfer, and the work.
    expect(limits[0]).toBeGreaterThanOrEqual(insideDelegate + 2n * 26_000n + 100_000n);
  });

  it('a node refusal and a failed hash record are definite "not sent"', async () => {
    const { EvmSendRejectedError } = await import('@modules/chains/evm/evm-send-rejected.error');
    const { channelSendNotSent } = await import('@modules/payment/ports/channel-door.port');
    const refused = sendingDoor(async () => {
      throw new EvmSendRejectedError('NONCE_TOO_LOW', '0x1');
    });
    const e1 = await refused.collect(ASSET, [REF as never], [0n], 'ORDINARY').catch((e) => e);
    expect(channelSendNotSent(e1)).toBe(true);
    const hookFails = sendingDoor(async (call) => {
      await call.beforeBroadcast('0x2');
      return { hash: '0x2', status: 'SUCCESS', revertReason: null, gasUsed: 1n, blockNumber: 1n };
    });
    const e2 = await hookFails
      .collect(ASSET, [REF as never], [0n], 'ORDINARY', {
        beforeBroadcast: async () => {
          throw new Error('db down');
        },
      })
      .catch((e) => e);
    expect(channelSendNotSent(e2)).toBe(true);
  });

  it('a failure after the broadcast (receipt timeout) is an UNKNOWN outcome, not "not sent"', async () => {
    const { channelSendNotSent } = await import('@modules/payment/ports/channel-door.port');
    const d = sendingDoor(async (call) => {
      await call.beforeBroadcast?.('0x3');
      throw new Error('Timed out while waiting for transaction with hash 0x3 to be confirmed.');
    });
    const error = await d.collect(ASSET, [REF as never], [0n], 'ORDINARY').catch((e) => e);
    expect(channelSendNotSent(error)).toBe(false);
  });

  it('a mined revert changed nothing: "not sent"', async () => {
    const { channelSendNotSent } = await import('@modules/payment/ports/channel-door.port');
    const d = sendingDoor(async () => ({
      hash: '0x4',
      status: 'REVERTED',
      revertReason: 'ProgramPaused',
      gasUsed: 1n,
      blockNumber: 1n,
    }));
    const error = await d.collect(ASSET, [REF as never], [0n], 'ORDINARY').catch((e) => e);
    expect(channelSendNotSent(error)).toBe(true);
  });

  it('txReceipt: mined with its events, pending, or unknown', async () => {
    const refunded = {
      address: ESCROW,
      topics: encodeEventTopics({
        abi: CHANNEL_DOOR_ABI,
        eventName: 'ChannelRefunded',
        args: { key: `0x${'0c'.repeat(32)}`, payer: PAYER },
      }),
      data: encodeAbiParameters(
        [{ type: 'uint40' }, { type: 'uint64' }, { type: 'bytes32' }],
        [Number(500_001n << 16n), 100n, `0x${'ab'.repeat(32)}`],
      ),
    };
    const mined = sendingDoor(async () => undefined as never, {
      getTransactionReceipt: async () => ({ status: 'success', blockNumber: 5n, logs: [refunded] }),
      getBlock: async () => ({ timestamp: BigInt(NOW) }),
    });
    const receipt = await mined.txReceipt(ASSET, '0x5');
    expect(receipt).toMatchObject({ state: 'MINED', success: true, landedAt: NOW });
    expect((receipt as any).refunded[0]).toMatchObject({
      payer: PAYER,
      amount: 100n,
      refundId: `0x${'ab'.repeat(32)}`,
    });

    const notFound = Object.assign(new Error('Transaction receipt could not be found'), {
      name: 'TransactionReceiptNotFoundError',
    });
    const pending = sendingDoor(async () => undefined as never, {
      getTransactionReceipt: async () => {
        throw notFound;
      },
      getTransaction: async () => ({ blockNumber: null }),
    });
    expect(await pending.txReceipt(ASSET, '0x6')).toEqual({ state: 'PENDING' });
    const unknown = sendingDoor(async () => undefined as never, {
      getTransactionReceipt: async () => {
        throw notFound;
      },
      getTransaction: async () => {
        throw Object.assign(new Error('not found'), { name: 'TransactionNotFoundError' });
      },
    });
    expect(await unknown.txReceipt(ASSET, '0x7')).toEqual({ state: 'UNKNOWN' });
  });

  it('F2: only viem’s not-found errors mean "no receipt"; a method-not-found is a failure', async () => {
    const d = sendingDoor(async () => undefined as never, {
      getTransactionReceipt: async () => {
        throw new Error(
          'the method eth_getTransactionReceipt does not exist / is not available (not found)',
        );
      },
    });
    await expect(d.txReceipt(ASSET, '0x8')).rejects.toThrow(/not found/);
  });
});

describe('EvmChannelDoor — the books at one block (rev4)', () => {
  const books = [0n, 0n, 0n, 0n] as const;

  it('chainHead takes the number and the timestamp from one latest block', async () => {
    const getBlock = jest.fn(async () => ({ number: 4242n, timestamp: BigInt(NOW) }));
    expect(await door({ getBlock }).chainHead(ASSET)).toEqual({ number: 4242n, timestamp: NOW });
    expect(getBlock).toHaveBeenCalledTimes(1);
    expect(getBlock).toHaveBeenCalledWith({ blockTag: 'latest' });
  });

  it('chainHead throws when the block has no number or blocks cannot be read', async () => {
    await expect(
      door({ getBlock: async () => ({ number: null, timestamp: BigInt(NOW) }) }).chainHead(ASSET),
    ).rejects.toThrow(/no number/);
    await expect(door({}).chainHead(ASSET)).rejects.toThrow(/cannot read blocks/);
  });

  it('readBooks pins the read to the given block, and reads latest without one', async () => {
    const readContract = jest.fn(async (_args: Record<string, unknown>) => books);
    const key = `0x${'cc'.repeat(32)}` as const;
    await door({ readContract }).readBooks(ASSET, key, undefined, 4242n);
    expect(readContract.mock.calls[0]).toEqual([
      expect.objectContaining({ functionName: 'channelBooks', blockNumber: 4242n }),
    ]);
    await door({ readContract }).readBooks(ASSET, key);
    expect(readContract.mock.calls[1][0]).not.toHaveProperty('blockNumber');
  });
});

describe('EvmChannelDoor — refundId and the dropped-verdict reads (sec-audit 2026-11-01 M-1)', () => {
  const KEY = `0x${'0c'.repeat(32)}` as const;
  const RID = `0x${'ab'.repeat(32)}` as const;

  it('the ABI matches the contract change: refundChannels takes refundIds, ChannelRefunded carries one', () => {
    const fn = CHANNEL_DOOR_ABI.find((i) => i.type === 'function' && i.name === 'refundChannels');
    expect(toFunctionSelector(fn as never)).toBe(
      toFunctionSelector(
        'refundChannels((address,address,address,bytes32)[],uint40[],uint64[],bytes32[])',
      ),
    );
    const event = CHANNEL_DOOR_ABI.find((i) => i.type === 'event' && i.name === 'ChannelRefunded');
    expect(toEventSelector(event as never)).toBe(
      toEventSelector('ChannelRefunded(bytes32,address,uint40,uint64,bytes32)'),
    );
  });

  it('nonceAndReceipts: one batch, nonces first, PENDING for a known tx without a receipt', async () => {
    const rpcBatch = jest.fn(async (calls: { method: string }[]) => {
      expect(calls.map((c) => c.method)).toEqual([
        'eth_getTransactionCount',
        'eth_getTransactionReceipt',
        'eth_getTransactionReceipt',
        'eth_getTransactionByHash',
        'eth_getTransactionByHash',
      ]);
      return ['0x8', null, null, null, { hash: '0x2', blockNumber: null }];
    });
    const getTransactionCount = jest.fn();
    const read = await door({ rpcBatch, getTransactionCount }).nonceAndReceipts(
      ASSET,
      [REDEEMER],
      ['0x1', '0x2'],
    );
    expect(read.nonces.get(REDEEMER.toLowerCase())).toBe(8n);
    expect(read.receipts.get('0x1')).toBe('UNKNOWN');
    expect(read.receipts.get('0x2')).toBe('PENDING');
    expect(rpcBatch).toHaveBeenCalledTimes(1);
    expect(getTransactionCount).not.toHaveBeenCalled();
  });

  it('nonceAndReceipts: a refused batch falls back to one-by-one reads', async () => {
    const client = {
      rpcBatch: jest.fn(async () => Promise.reject(new Error('batch refused'))),
      getTransactionCount: jest.fn(async () => 9),
      getTransactionReceipt: jest.fn(async () => ({
        status: 'success',
        blockNumber: 3n,
        logs: [],
      })),
    };
    const read = await door(client).nonceAndReceipts(ASSET, [REDEEMER], ['0x1']);
    expect(read.nonces.get(REDEEMER.toLowerCase())).toBe(9n);
    expect(read.receipts.get('0x1')).toBe('MINED');
  });

  it('findRefundLanding: finds the ChannelRefunded log with this refundId, scanning back in pages', async () => {
    const log = (refundId: `0x${string}`, tx: string) => ({
      address: ESCROW,
      topics: encodeEventTopics({
        abi: CHANNEL_DOOR_ABI,
        eventName: 'ChannelRefunded',
        args: { key: KEY, payer: PAYER },
      }),
      data: encodeAbiParameters(
        [{ type: 'uint40' }, { type: 'uint64' }, { type: 'bytes32' }],
        [Number(500_001n << 16n), 100n, refundId],
      ),
      transactionHash: tx,
      blockNumber: 15_000n,
    });
    const getLogs = jest.fn(async ({ toBlock }: { toBlock: bigint }) =>
      toBlock === 30_000n ? [log(`0x${'cd'.repeat(32)}`, '0xother')] : [log(RID, '0xlanded')],
    );
    const found = await door({ getBlockNumber: async () => 30_000n, getLogs }).findRefundLanding(
      ASSET,
      KEY,
      RID,
      100_000n,
    );
    expect(found).toEqual({ txRef: '0xlanded', blockNumber: 15_000n, amount: 100n });
    expect(getLogs).toHaveBeenCalledTimes(2);
    const none = await door({
      getBlockNumber: async () => 30_000n,
      getLogs: async () => [],
    }).findRefundLanding(ASSET, KEY, RID, 25_000n);
    expect(none).toBeNull();
  });
});
