import { encodeAbiParameters, keccak256, parseTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { Alert, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { CHAIN_IDS, ChainId, toAccountId } from '@modules/chains/ports/caip.types';
import {
  EVM_REDEEMER_IDENTITY,
  EvmRelayClient,
  EvmRelayer,
  EvmSenderIdentity,
} from '@modules/chains/evm/evm-relayer.service';
import { EvmValueTransfer } from '@modules/chains/evm/ports/evm-relayer.port';
import { NODE_INTERFACE_ADDRESS } from '@modules/chains/evm/evm-l1-gas';
import { EvmSendRejectedError } from '@modules/chains/evm/evm-send-rejected.error';
import { EvmRpcError } from '@modules/chains/evm/sanctioned-evm-rpc';
import {
  DEFAULT_EVM_RELAYER_RECEIPT_TIMEOUT_MS,
  EvmRelayerTiming,
  readEvmRelayerTiming,
} from '@modules/chains/evm/evm-relayer-timing';

/**
 * The relayer EOA: it sends transactions, it never signs a user's, and it
 * can never move USDG.
 *
 * ## What the assertions are made against
 *
 * The stub captures the **serialized** transaction and every assertion decodes
 * it with viem's `parseTransaction` — a different code path from the one that
 * built it. Capturing the object before signing would assert that the relayer
 * passed its own arguments along, which is true of any implementation
 * including one that then signs something else.
 */
const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const RELAYER_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const RELAYER_ADDRESS = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const ESCROW = '0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac';
const CALLDATA = '0xa9059cbb0000000000000000000000000000000000000000000000000000000000000001';

/** `EscrowInsufficient()`, from `Errors.sol` by way of the selector table. */
const ESCROW_INSUFFICIENT = '0x71de3750';

describe('EvmRelayer', () => {
  it('is the account the key implies, in CAIP-10', async () => {
    const { relayer } = build();

    await expect(relayer.address(TESTNET)).resolves.toBe(toAccountId(TESTNET, RELAYER_ADDRESS));
    // The independent source: the same key, through viem's own derivation.
    expect(privateKeyToAccount(RELAYER_KEY).address).toBe(RELAYER_ADDRESS);
  });

  it('sends the calldata it was given, to the address it was given', async () => {
    const { relayer, node } = build();

    const result = await relayer.sendCall({
      chainId: TESTNET,
      to: toAccountId(TESTNET, ESCROW),
      data: CALLDATA,
      gasLimit: 250_000n,
      purpose: 'redeem',
    });

    expect(result.status).toBe('SUCCESS');
    const [tx] = node.decoded();
    expect(tx.to?.toLowerCase()).toBe(ESCROW.toLowerCase());
    expect(tx.data).toBe(CALLDATA);
    expect(tx.gas).toBe(250_000n);
    expect(tx.value ?? 0n).toBe(0n);
    // The chain id is IN the signed payload (EIP-155), so a transaction signed
    // for the wrong chain cannot be replayed onto this one.
    expect(tx.chainId).toBe(46630);
  });

  /** REGRESSION (review 2026-10-15 P-1): the redemption job records the hash before it is sent. */
  it('hands the signed transaction’s hash to beforeBroadcast before broadcasting it', async () => {
    const { relayer, node } = build();
    const seen: { hash: string; sentBefore: number }[] = [];

    await relayer.sendCall({
      ...call(),
      beforeBroadcast: async (hash) => {
        seen.push({ hash, sentBefore: node.sent.length });
      },
    });

    expect(seen).toEqual([{ hash: keccak256(node.sent[0]), sentBefore: 0 }]);
  });

  it('broadcasts nothing when beforeBroadcast rejects', async () => {
    const { relayer, node } = build();

    await expect(
      relayer.sendCall({
        ...call(),
        beforeBroadcast: async () => {
          throw new Error('database down');
        },
      }),
    ).rejects.toThrow('database down');
    expect(node.sent).toHaveLength(0);
  });

  it('signs EIP-1559 and never a legacy gasPrice', async () => {
    const { relayer, node } = build();

    await relayer.sendCall(call());

    const [tx] = node.decoded();
    expect(tx.type).toBe('eip1559');
    expect(tx.maxFeePerGas).toBe(node.fees.maxFeePerGas);
    expect(tx.maxPriorityFeePerGas).toBe(node.fees.maxPriorityFeePerGas);
    expect(tx).not.toHaveProperty('gasPrice');
  });

  it('reads the nonce once per send and does not reuse a stale one', async () => {
    // Two sends in a row must use n and n+1. A relayer that cached the nonce —
    // across a process restart, or across a failed send — produces a
    // REPLACEMENT transaction rather than a second one, which silently drops a
    // redemption while reporting a hash.
    const { relayer, node } = build();

    await relayer.sendCall(call());
    await relayer.sendCall(call());

    expect(node.decoded().map((tx) => tx.nonce)).toEqual([7, 8]);
    expect(node.nonceReads).toBe(2);
  });

  it('serialises concurrent sends so two redemptions cannot draw one nonce', async () => {
    // The failure this prevents is not hypothetical: the batch job and the gas
    // grant both send, and `getTransactionCount` is a round trip. Without a
    // per-chain queue both reads return 7, both transactions are signed with
    // nonce 7, and the second replaces the first in the mempool.
    const { relayer, node } = build({ nonceLatencyTicks: 3 });

    await Promise.all([relayer.sendCall(call()), relayer.sendCall(call())]);

    expect(
      node
        .decoded()
        .map((tx) => tx.nonce)
        .sort(),
    ).toEqual([7, 8]);
  });

  it('reports a revert by its Errors.sol NAME, not as a success', async () => {
    const { relayer, node } = build();
    node.revertWith(ESCROW_INSUFFICIENT);

    const result = await relayer.sendCall(call());

    expect(result).toEqual(
      expect.objectContaining({ status: 'REVERTED', revertReason: 'EscrowInsufficient' }),
    );
  });

  it('names an unrecognised revert rather than reporting SUCCESS', async () => {
    // The control. `revertReason: null` on a REVERTED result would let a caller
    // treat "we do not know why it failed" as "it did not fail".
    const { relayer, node } = build();
    node.revertWith('0xdeadbeef');

    const result = await relayer.sendCall(call());

    expect(result.status).toBe('REVERTED');
    expect(result.revertReason).toBe('UNKNOWN_REVERT:0xdeadbeef');
  });

  it('is still REVERTED when the revert data cannot be recovered at all', async () => {
    // A node that will not re-run the call — pruned state, a rate limit — must
    // not turn a reverted transaction into a successful one. The reason
    // degrades; the status does not.
    const { relayer, node } = build();
    node.revertWith(null);

    const result = await relayer.sendCall(call());

    expect(result.status).toBe('REVERTED');
    expect(result.revertReason).toBe('UNKNOWN_REVERT:none');
  });

  it('sends value with no calldata at all', async () => {
    const { relayer, node } = build();

    await relayer.sendValue({
      chainId: TESTNET,
      to: toAccountId(TESTNET, ESCROW),
      wei: 1_000_000_000_000_000n,
      purpose: 'gas grant',
    });

    const [tx] = node.decoded();
    expect(tx.value).toBe(1_000_000_000_000_000n);
    // Empty, not "the calldata of the last call" and not undefined-as-anything.
    expect(tx.data === undefined || tx.data === '0x').toBe(true);
    // No NodeInterface answered: 21 000 plus the fixed L1 margin, never a bare
    // 21 000 that Nitro refuses as soon as L1 costs anything.
    expect(tx.gas).toBe(21_000n + 200_000n);
  });

  it('gives a value transfer its L1 part, padded 20 %, when NodeInterface answers', async () => {
    const { relayer, node } = build();
    node.l1 = { gas: 50_000n, baseFee: 20_000_000n };

    await relayer.sendValue({
      chainId: TESTNET,
      to: toAccountId(TESTNET, ESCROW),
      wei: 1n,
      purpose: 'gas grant',
    });

    expect(node.decoded()[0].gas).toBe(21_000n + 60_000n);
  });

  describe('a send the node refused (definitely not broadcast)', () => {
    it.each([
      ['insufficient funds for gas * price + value', 'INSUFFICIENT_FUNDS'],
      ['nonce too low', 'NONCE_TOO_LOW'],
      ['nonce too high', 'NONCE_TOO_HIGH'],
      ['intrinsic gas too low', 'INTRINSIC_GAS_TOO_LOW'],
      ['max fee per gas less than block base fee', 'FEE_CAP_TOO_LOW'],
      ['replacement transaction underpriced', 'REPLACEMENT_UNDERPRICED'],
    ])('"%s" is EvmSendRejectedError %s, carrying the recorded hash', async (message, reason) => {
      const { relayer, node } = build();
      node.sendError = new Error(message);
      const recorded: string[] = [];

      const error = await relayer
        .sendCall({ ...call(), beforeBroadcast: async (hash) => void recorded.push(hash) })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EvmSendRejectedError);
      expect((error as EvmSendRejectedError).reason).toBe(reason);
      expect((error as EvmSendRejectedError).broadcast).toBe(false);
      // The hash the caller recorded is the one the error names.
      expect((error as EvmSendRejectedError).hash).toBe(recorded[0]);
      expect(node.receiptWaits).toHaveLength(0);
    });

    it('reads the tag the sanctioned transport sets, not only the message', async () => {
      const { relayer, node } = build();
      node.sendError = new EvmRpcError('EVM RPC eth_sendRawTransaction failed: code -32000', {
        code: -32000,
        data: null,
        sendAnswer: 'INSUFFICIENT_FUNDS',
      });

      await expect(relayer.sendCall(call())).rejects.toMatchObject({
        name: 'EvmSendRejectedError',
        reason: 'INSUFFICIENT_FUNDS',
      });
    });

    it('treats "already known" as broadcast, and waits for the receipt of the signed hash', async () => {
      const { relayer, node } = build();
      node.sendError = new Error('already known');
      const recorded: string[] = [];

      const result = await relayer.sendCall({
        ...call(),
        beforeBroadcast: async (hash) => void recorded.push(hash),
      });

      expect(result.status).toBe('SUCCESS');
      expect(result.hash).toBe(recorded[0]);
      expect(node.receiptWaits[0].hash).toBe(recorded[0]);
    });

    it('rethrows anything else untouched: the outcome is unknown', async () => {
      const { relayer, node } = build();
      const timeout = new Error('EVM RPC eth_sendRawTransaction failed: HTTP 504');
      node.sendError = timeout;

      await expect(relayer.sendCall(call())).rejects.toBe(timeout);
    });
  });

  it('refuses, before signing or recording anything, a send the balance cannot cover', async () => {
    const { relayer, node } = build();
    // 250 000 gas × 1.5 gwei = 3.75e14 wei; one wei short.
    node.balance = 250_000n * node.fees.maxFeePerGas - 1n;
    let recorded = false;

    const error = await relayer
      .sendCall({ ...call(), beforeBroadcast: async () => void (recorded = true) })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EvmSendRejectedError);
    expect((error as EvmSendRejectedError).reason).toBe('INSUFFICIENT_FUNDS');
    expect((error as EvmSendRejectedError).hash).toBeNull();
    expect(recorded).toBe(false);
    expect(node.sent).toHaveLength(0);
  });

  it('counts the value in that check, and sends when the balance covers it exactly', async () => {
    const { relayer, node } = build();
    node.balance = 250_000n * node.fees.maxFeePerGas;

    await expect(relayer.sendCall(call())).resolves.toMatchObject({ status: 'SUCCESS' });
  });

  it('leaves the check to the node when the balance cannot be read', async () => {
    const { relayer, node } = build();
    node.getBalance = async () => {
      throw new Error('rpc down');
    };

    await expect(relayer.sendCall(call())).resolves.toMatchObject({ status: 'SUCCESS' });
  });

  it('sendValue has no way to carry calldata', () => {
    // Structural, and the reason the relayer's value transfers are safe. If somebody adds a `data`
    // field to `EvmValueTransfer`, this fails — and it is the only thing that
    // would, because a widened type compiles everywhere.
    const transfer: EvmValueTransfer = {
      chainId: TESTNET,
      to: toAccountId(TESTNET, ESCROW),
      wei: 1n,
      purpose: 'x',
    };

    expect(Object.keys(transfer).sort()).toEqual(['chainId', 'purpose', 'to', 'wei']);
  });

  it('refuses a chain it holds no key for, before touching the network', async () => {
    const { relayer, node } = build({ keys: [] });

    await expect(relayer.sendCall(call())).rejects.toThrow(/EVM_RELAYER_KEYS/);
    expect(node.sent).toHaveLength(0);
  });

  it('is the relayer by default: its name and its missing-key error say so', async () => {
    const { relayer } = build({ keys: [] });

    expect(relayer.name).toBe('evm-relayer-eoa');
    await expect(relayer.address(TESTNET)).rejects.toThrow(/relayer key/);
  });

  it('as the REDEEMER, names EVM_REDEEMER_KEYS — never EVM_RELAYER_KEYS — when it has no key', async () => {
    const { relayer, node } = build({ keys: [], identity: EVM_REDEEMER_IDENTITY });

    expect(relayer.name).toBe('evm-redeemer-eoa');
    const error = await relayer.sendCall(call()).then(
      () => null,
      (caught: Error) => caught,
    );
    expect(error.message).toContain('EVM_REDEEMER_KEYS');
    expect(error.message).not.toContain('EVM_RELAYER_KEYS');
    expect(node.sent).toHaveLength(0);
  });

  it('as the REDEEMER, raises its low-float alert in its own bucket, naming the key', async () => {
    // One condition per KEY: the relayer's bucket is the bare chain id, and the
    // redeemer's must differ, or one key running dry silences the other's page.
    const { relayer, node, alerts } = build({
      lowWaterMarkWei: 10n ** 16n,
      identity: EVM_REDEEMER_IDENTITY,
    });
    node.balance = 10n ** 15n;

    await relayer.sendCall(call());

    expect(alerts.emitted).toHaveLength(1);
    expect(alerts.emitted[0].dedupeKey).toBe(`${TESTNET}:redeemer`);
    expect(alerts.emitted[0].details).toEqual(
      expect.objectContaining({ key: 'redeemer', redeemer: RELAYER_ADDRESS }),
    );
    expect(alerts.emitted[0].summary).toContain('redeemer');
  });

  it('refuses to send to a different chain than the one it was asked for', async () => {
    // `to` is CAIP-10 and carries its own chain. A mismatch means somebody
    // built the call from two sources, and sending it anyway puts the platform's
    // gas behind an address that was never checked on this chain.
    const { relayer, node } = build();

    await expect(
      relayer.sendCall({ ...call(), to: toAccountId(CHAIN_IDS.ROBINHOOD_MAINNET, ESCROW) }),
    ).rejects.toThrow(/eip155:4663/);
    expect(node.sent).toHaveLength(0);
  });

  it('warns once when the float is low, and not at all when it is not', async () => {
    // The float is the whole loss budget, so it has to be visible before it is
    // empty — and `ONCE_PER_INCIDENT`, because an empty relayer otherwise
    // produces one alert per attempted send, which is how a channel gets muted.
    const { relayer, node, alerts } = build({ lowWaterMarkWei: 10n ** 16n });
    node.balance = 10n ** 15n;

    await relayer.sendCall(call());

    expect(alerts.emitted).toHaveLength(1);
    expect(alerts.emitted[0]).toEqual(
      expect.objectContaining({
        severity: AlertSeverity.WARN,
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: TESTNET,
      }),
    );
  });

  it('stays quiet while the float is above the mark', async () => {
    const { relayer, node, alerts } = build({ lowWaterMarkWei: 10n ** 16n });
    node.balance = 10n ** 17n;

    await relayer.sendCall(call());

    expect(alerts.emitted).toHaveLength(0);
  });

  /**
   * BUG-D1-07 review, finding 2: the admission pause around a relayed
   * tightening is computed from these two settings, so the relayer must obey
   * exactly them — the receipt timeout passed to viem explicitly, and the queue
   * wait bounded for a send that asks for it.
   */
  describe('timing (BUG-D1-07 review)', () => {
    it('passes its receipt timeout to viem explicitly, from config or the default', async () => {
      const configured = build({ timing: { receiptTimeoutMs: 42_000, maxQueueWaitMs: 1_000 } });
      await configured.relayer.sendCall(call());
      expect(configured.node.receiptWaits[0].timeout).toBe(42_000);

      const defaulted = build();
      await defaulted.relayer.sendCall(call());
      expect(defaulted.node.receiptWaits[0].timeout).toBe(DEFAULT_EVM_RELAYER_RECEIPT_TIMEOUT_MS);
    });

    it('gives a bounded send up UNSENT when it waited in the queue past the bound', async () => {
      const { relayer, node } = build({ timing: { receiptTimeoutMs: 10_000, maxQueueWaitMs: 50 } });
      let release!: () => void;
      node.receiptGate = new Promise<void>((resolve) => (release = resolve));
      const ahead = relayer.sendCall(call());
      const bounded = relayer.sendCall({ ...call(), boundQueueWait: true });
      const unbounded = relayer.sendCall(call());
      await new Promise((resolve) => setTimeout(resolve, 80));
      release();
      node.receiptGate = null;

      await expect(ahead).resolves.toMatchObject({ status: 'SUCCESS' });
      await expect(bounded).rejects.toMatchObject({ errorCode: 'CHAIN_RELAY_NOT_SENT' });
      // Nothing was signed for it; the send behind it still goes.
      await expect(unbounded).resolves.toMatchObject({ status: 'SUCCESS' });
      expect(node.sent).toHaveLength(2);
    });

    it('reads both settings from config, and refuses a malformed one', () => {
      const env: Record<string, string> = {
        EVM_RELAYER_RECEIPT_TIMEOUT_MS: '90000',
        EVM_RELAYER_MAX_QUEUE_WAIT_MS: '30000',
      };
      expect(readEvmRelayerTiming((key) => env[key])).toEqual({
        receiptTimeoutMs: 90_000,
        maxQueueWaitMs: 30_000,
      });
      expect(() => readEvmRelayerTiming(() => '-1')).toThrow('positive whole number');
    });
  });

  it('exposes no method that could return key material', () => {
    // The same reflective check `signer-port.contract.ts` makes, for the same
    // reason: TypeScript is erased at runtime, and what leaks is a method
    // somebody added to a class.
    const { relayer } = build();
    const surface = [
      ...Object.getOwnPropertyNames(relayer),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(relayer)),
    ];

    for (const forbidden of [
      'exportKey',
      'export',
      'getSecret',
      'getPrivateKey',
      'privateKey',
      'secretKey',
      'seed',
      'keyMaterial',
      'account',
      'accounts',
    ]) {
      expect(surface).not.toContain(forbidden);
    }
  });
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function call() {
  return {
    chainId: TESTNET,
    to: toAccountId(TESTNET, ESCROW),
    data: CALLDATA as `0x${string}`,
    gasLimit: 250_000n,
    purpose: 'redeem',
  };
}

/** A node that behaves like one: the pending count moves when a tx is sent. */
class FakeNode implements EvmRelayClient {
  readonly sent: `0x${string}`[] = [];
  readonly fees = { maxFeePerGas: 1_500_000_000n, maxPriorityFeePerGas: 100_000_000n };

  nonceReads = 0;
  balance = 10n ** 18n;

  private pending = 7;
  private reverting: { data: `0x${string}` | null } | null = null;

  constructor(private readonly nonceLatencyTicks = 0) {}

  revertWith(data: string | null): void {
    this.reverting = { data: data as `0x${string}` | null };
  }

  decoded() {
    return this.sent.map((raw) => parseTransaction(raw));
  }

  async getTransactionCount(): Promise<number> {
    this.nonceReads += 1;
    for (let i = 0; i < this.nonceLatencyTicks; i += 1) {
      await Promise.resolve();
    }
    return this.pending;
  }

  async getBalance(): Promise<bigint> {
    return this.balance;
  }

  async estimateFeesPerGas() {
    return this.fees;
  }

  /** Set by a test: the node refuses the next send with this. */
  sendError: unknown = null;
  /** Set by a test: what `NodeInterface.gasEstimateL1Component` answers. */
  l1: { gas: bigint; baseFee: bigint } | null = null;

  async sendRawTransaction(args: { serializedTransaction: `0x${string}` }): Promise<`0x${string}`> {
    if (this.sendError) {
      const error = this.sendError;
      this.sendError = null;
      throw error;
    }
    this.sent.push(args.serializedTransaction);
    this.pending += 1;
    return `0x${'ab'.repeat(32)}`;
  }

  readonly receiptWaits: Array<{ hash: string; timeout?: number }> = [];
  /** Set by a test: the receipt arrives only when this resolves. */
  receiptGate: Promise<void> | null = null;

  async waitForTransactionReceipt(args: { hash: `0x${string}`; timeout?: number }) {
    this.receiptWaits.push(args);
    if (this.receiptGate) await this.receiptGate;
    return {
      status: (this.reverting ? 'reverted' : 'success') as 'success' | 'reverted',
      gasUsed: 123_456n,
      blockNumber: 999n,
    };
  }

  async call(args?: { to?: string }): Promise<unknown> {
    if (this.l1 && args?.to?.toLowerCase() === NODE_INTERFACE_ADDRESS.toLowerCase()) {
      return {
        data: encodeAbiParameters(
          [{ type: 'uint64' }, { type: 'uint256' }, { type: 'uint256' }],
          [this.l1.gas, this.l1.baseFee, 0n],
        ),
      };
    }
    if (!this.reverting) {
      return '0x';
    }
    // What the sanctioned transport throws for an `eth_call` revert.
    throw Object.assign(new Error('EVM RPC eth_call failed: code 3'), {
      data: this.reverting.data,
    });
  }
}

class FakeAlerts implements AlertPort {
  readonly emitted: Alert[] = [];

  async emit(alert: Alert): Promise<void> {
    this.emitted.push(alert);
  }
}

function build(
  options: {
    keys?: readonly { chainId: ChainId; secretKey: `0x${string}` }[];
    lowWaterMarkWei?: bigint;
    nonceLatencyTicks?: number;
    timing?: EvmRelayerTiming;
    identity?: EvmSenderIdentity;
  } = {},
) {
  const node = new FakeNode(options.nonceLatencyTicks ?? 0);
  const alerts = new FakeAlerts();
  const relayer = new EvmRelayer(
    new Map<ChainId, EvmRelayClient>([[TESTNET, node]]),
    options.keys ?? [{ chainId: TESTNET, secretKey: RELAYER_KEY }],
    alerts,
    options.lowWaterMarkWei ?? 0n,
    options.timing,
    options.identity,
  );
  return { relayer, node, alerts };
}
