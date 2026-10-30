import { keccak256 } from 'viem';
import { PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';

import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';
import { Inject, Injectable } from '@nestjs/common';

import { ChainErrors } from '../errors/chains.errors';
import { AccountId, ChainId, parseAccountId, parseChainId } from '../ports/caip.types';
import { evmErrorName, revertDataOf } from './abi/error-selectors';
import {
  EVM_REDEEMER_KEYS_ENV,
  EVM_RELAYER_KEYS_ENV,
  EVM_RELAYER_KEY_SOURCES,
  EvmRelayerKeySource,
} from './evm-relayer-key-source';
import { EvmSendingKey, floatDedupeKey } from './evm-relayer-float.constants';
import { DEFAULT_EVM_RELAYER_TIMING, EvmRelayerTiming } from './evm-relayer-timing';
import { estimateL1Gas, paddedL1Gas } from './evm-l1-gas';
import { EvmSendRejectedError, sendAnswerOf } from './evm-send-rejected.error';
import {
  EvmRelayResult,
  EvmRelayedCall,
  EvmRelayerPort,
  EvmValueTransfer,
} from './ports/evm-relayer.port';

/**
 * The write half of a JSON-RPC client, declared structurally so a test can
 * supply one.
 *
 * Separate from `EvmReadClient` (the adapter's) rather than a superset of it:
 * the adapter is read-only by construction and giving it a `sendRawTransaction`
 * — even one it never calls — makes that a property of the code review rather
 * than of the type.
 */
export interface EvmRelayClient {
  getTransactionCount(args: { address: `0x${string}`; blockTag: 'pending' }): Promise<number>;
  getBalance(args: { address: `0x${string}` }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  sendRawTransaction(args: { serializedTransaction: `0x${string}` }): Promise<`0x${string}`>;
  waitForTransactionReceipt(args: { hash: `0x${string}`; timeout?: number }): Promise<{
    status: 'success' | 'reverted';
    gasUsed: bigint;
    blockNumber: bigint;
  }>;
  call(args: {
    account?: `0x${string}`;
    to: `0x${string}`;
    data: `0x${string}`;
    blockNumber?: bigint;
  }): Promise<unknown>;
}

/** The intrinsic gas of a plain value transfer to an account. */
export const EVM_VALUE_TRANSFER_GAS = 21_000n;

/**
 * The gas a value transfer gets for its L1 part when the L1 part could not be
 * read (`NodeInterface` did not answer). On Nitro the gas limit must cover the
 * L1 data fee too, so a bare 21 000 is refused as `intrinsic gas too low` as
 * soon as L1 costs anything. A transfer carries about 110 bytes, under half of
 * a `setLimitsBySig`, whose L1 part measured about 845k gas at the worst spike
 * seen. Unused gas is not charged, so the margin costs only balance headroom
 * (about 5e-6 ETH at 0.024 gwei).
 */
export const EVM_VALUE_TRANSFER_FALLBACK_L1_GAS = 200_000n;

/** How little ETH is too little, when nothing says otherwise. */
export const DEFAULT_RELAYER_LOW_WATER_MARK_WEI = 5_000_000_000_000_000n; // 0.005 ETH

/**
 * Which key an `EvmRelayer` instance holds: its port name, the variable its
 * key came from (named in every "no key" error), and its role in alerts.
 */
export interface EvmSenderIdentity {
  readonly name: string;
  readonly keysVariable: string;
  readonly key: EvmSendingKey;
}

/** The relayer: buyer-signed `*BySig` requests, gas grants, slash sends. No on-chain role. */
export const EVM_RELAYER_IDENTITY: EvmSenderIdentity = {
  name: 'evm-relayer-eoa',
  keysVariable: EVM_RELAYER_KEYS_ENV,
  key: 'relayer',
};

/** The redeemer: `Config.params().redeemer`, the only sender `redeemVoucher[Batch]` accepts. */
export const EVM_REDEEMER_IDENTITY: EvmSenderIdentity = {
  name: 'evm-redeemer-eoa',
  keysVariable: EVM_REDEEMER_KEYS_ENV,
  key: 'redeemer',
};

/**
 * The relayer EOA, and the only thing in this codebase that signs and
 * sends an EVM transaction of its own. (`EvmFacilitator` also broadcasts, but
 * only bytes a buyer signed — it holds no key and cannot author one.)
 *
 * Read `ports/evm-relayer.port.ts` first: the argument for why a leak of this
 * key costs the ETH float and nothing else lives there, beside the type it
 * justifies.
 *
 * ## Two instances, two keys
 *
 * The class is instantiated twice: the RELAYER (`EVM_RELAYER_KEYS`, no on-chain
 * role) and the REDEEMER (`EVM_REDEEMER_KEYS`, the address in
 * `Config.params().redeemer`), each with its own {@link EvmSenderIdentity}.
 * `EvmModule` refuses to boot when the two keys are the same on a chain.
 *
 * ## The key, and what this class does to earn holding it
 *
 * The key variable is read once at boot and **deleted from `process.env`**,
 * through the same `takeOnceFromEnv` the verifier keys go through. The scalars
 * are turned into viem accounts in the constructor and the source buffers are
 * blanked; there is no method that returns one, and there is no field on this
 * object that holds one — `#accounts` is a true private field, so nothing that
 * walks the object finds it.
 *
 * What it cannot do, and says so: hold the material non-extractably. viem's
 * account keeps the scalar. A KMS closes that and nothing at this layer can.
 *
 * ## Nonces
 *
 * Read per send, at `blockTag: 'pending'`, and **serialised per chain** through
 * an in-process promise chain. Both halves are load-bearing:
 *
 * - a cached nonce survives a failed send and produces a *replacement*
 *   transaction rather than a second one, which drops a redemption while
 *   returning a hash;
 * - two concurrent sends both read the same pending count, sign the same nonce,
 *   and the second replaces the first in the mempool. On the relayer, relayed
 *   requests, slash sends and the gas grant all send; on the redeemer, single
 *   and batch redemptions do — a real interleaving either way, not a thought
 *   experiment.
 *
 * The queue is per chain because nonces are per chain per account; one global
 * queue would serialise 46630 behind 4663 for no reason.
 *
 * ## Reverts
 *
 * A receipt says `reverted` and nothing else — the reason is not in it. So the
 * call is re-run with `eth_call` at the receipt's block, the revert data is
 * mapped through `evmErrorName`, and the result carries the `Errors.sol` name.
 * When the data cannot be recovered the reason degrades to
 * `UNKNOWN_REVERT:none`; **the status never does.**
 */
@Injectable()
export class EvmRelayer implements EvmRelayerPort {
  readonly name: string;

  /** `chainId` → the account. A `#private` field: not an own property. */
  readonly #accounts: ReadonlyMap<ChainId, PrivateKeyAccount>;

  /** `chainId` → the tail of that chain's send queue. */
  private readonly queues = new Map<ChainId, Promise<unknown>>();

  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmRelayClient>,
    @Inject(EVM_RELAYER_KEY_SOURCES) sources: readonly EvmRelayerKeySource[],
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    private readonly lowWaterMarkWei: bigint = DEFAULT_RELAYER_LOW_WATER_MARK_WEI,
    private readonly timing: EvmRelayerTiming = DEFAULT_EVM_RELAYER_TIMING,
    private readonly identity: EvmSenderIdentity = EVM_RELAYER_IDENTITY,
  ) {
    this.name = identity.name;
    this.#accounts = new Map(
      sources.map((source) => [source.chainId, privateKeyToAccount(source.secretKey)] as const),
    );
  }

  async address(chainId: ChainId): Promise<AccountId> {
    return this.accountId(chainId);
  }

  async balanceWei(chainId: ChainId): Promise<bigint> {
    return this.clientFor(chainId).getBalance({ address: this.accountFor(chainId).address });
  }

  async feesPerGas(
    chainId: ChainId,
  ): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    return this.clientFor(chainId).estimateFeesPerGas();
  }

  async sendCall(call: EvmRelayedCall): Promise<EvmRelayResult> {
    const to = this.addressOnChain(call.chainId, call.to);
    return this.send(
      call.chainId,
      { to, data: call.data, value: 0n, gas: call.gasLimit },
      call.boundQueueWait ? Date.now() + this.timing.maxQueueWaitMs : null,
      call.beforeBroadcast,
    );
  }

  async sendValue(transfer: EvmValueTransfer): Promise<EvmRelayResult> {
    const to = this.addressOnChain(transfer.chainId, transfer.to);
    // `data` is absent, not empty-and-overwritable. `gas` is the intrinsic cost
    // of a transfer to an account plus, on Nitro, the L1 data fee in L2 gas.
    // There is nothing here to fill in.
    const gas = await this.valueTransferGas(transfer.chainId, to);
    return this.send(transfer.chainId, { to, value: transfer.wei, gas });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * One send, queued behind every other send on the same chain.
   *
   * The queue tail is replaced before awaiting, so a rejected send does not
   * poison the chain for every send after it — `catch` on the tail, not on the
   * caller's promise.
   */
  private send(
    chainId: ChainId,
    tx: { to: `0x${string}`; data?: `0x${string}`; value: bigint; gas: bigint },
    /** Epoch ms after which this send is given up unsent, or null to wait its turn however long. */
    sendBy: number | null = null,
    beforeBroadcast?: (hash: `0x${string}`) => Promise<void>,
  ): Promise<EvmRelayResult> {
    const previous = this.queues.get(chainId) ?? Promise.resolve();
    const queuedAt = Date.now();
    const turn = () => {
      if (sendBy !== null && Date.now() > sendBy) {
        // Nothing signed, nothing broadcast: a definite "did not happen".
        throw ChainErrors.relayNotSent({ waitedMs: Date.now() - queuedAt });
      }
      return this.sendNow(chainId, tx, beforeBroadcast);
    };
    const result = previous.then(turn, turn);
    this.queues.set(
      chainId,
      result.catch(() => undefined),
    );
    return result;
  }

  private async sendNow(
    chainId: ChainId,
    tx: { to: `0x${string}`; data?: `0x${string}`; value: bigint; gas: bigint },
    beforeBroadcast?: (hash: `0x${string}`) => Promise<void>,
  ): Promise<EvmRelayResult> {
    const client = this.clientFor(chainId);
    const account = this.accountFor(chainId);

    const [nonce, fees, balance] = await Promise.all([
      client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
      client.estimateFeesPerGas(),
      // Unknown is not "empty": a balance that cannot be read leaves the check
      // to the node, as before.
      client.getBalance({ address: account.address }).catch(() => null),
    ]);

    // The node's own admission rule, applied before anything is signed: a send
    // it would refuse for funds is refused here, with nothing signed, recorded
    // or broadcast.
    const worstCost = tx.gas * fees.maxFeePerGas + tx.value;
    if (balance !== null && balance < worstCost) {
      await this.warnIfFloatLowQuietly(chainId);
      throw new EvmSendRejectedError(
        'INSUFFICIENT_FUNDS',
        null,
        `the ${this.identity.key} holds ${balance} wei and this send may cost ${worstCost}`,
      );
    }

    const serializedTransaction = (await account.signTransaction({
      chainId: Number(parseChainId(chainId).reference),
      nonce,
      to: tx.to,
      value: tx.value,
      // Present only for a call. `sendValue` never reaches this branch with
      // anything, which is the type's guarantee rather than this line's.
      ...(tx.data === undefined ? {} : { data: tx.data }),
      gas: tx.gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      type: 'eip1559',
    })) as `0x${string}`;

    // The hash is the signed bytes' keccak, known before anything is sent. A
    // caller that records it first can find the transaction again if this
    // process never sees the receipt.
    const signedHash = keccak256(serializedTransaction);
    if (beforeBroadcast) {
      await beforeBroadcast(signedHash);
    }
    let hash: `0x${string}`;
    try {
      hash = await client.sendRawTransaction({ serializedTransaction });
    } catch (error) {
      // A refusal from the node's admission checks means the bytes were never
      // pooled: definitely not broadcast (`evm-send-rejected.error.ts`). "Already
      // known" means the node HAS them, so the broadcast happened and the
      // receipt is awaited as usual. Anything else is an unknown outcome and
      // is rethrown untouched.
      const answer = sendAnswerOf(error);
      if (answer === null) throw error;
      if (answer !== 'ALREADY_KNOWN') {
        if (answer === 'INSUFFICIENT_FUNDS') await this.warnIfFloatLowQuietly(chainId);
        throw new EvmSendRejectedError(answer, signedHash);
      }
      hash = signedHash;
    }
    // An explicit timeout, the one `relayedSendBudgetMs` counts on.
    const receipt = await client.waitForTransactionReceipt({
      hash,
      timeout: this.timing.receiptTimeoutMs,
    });

    // After the send, not before: the float is being reported, and reporting it
    // must not be able to stop a redemption that was going to work.
    await this.warnIfFloatLow(chainId);

    if (receipt.status === 'success') {
      return {
        hash,
        status: 'SUCCESS',
        revertReason: null,
        gasUsed: receipt.gasUsed,
        blockNumber: receipt.blockNumber,
      };
    }

    return {
      hash,
      status: 'REVERTED',
      revertReason: evmErrorName(
        await this.revertDataFor(client, account.address, tx, receipt.blockNumber),
      ),
      gasUsed: receipt.gasUsed,
      blockNumber: receipt.blockNumber,
    };
  }

  /**
   * Re-run the call at the block that reverted, to learn why.
   *
   * A receipt carries no reason, so this is the only route to one. Every
   * failure of the re-run — a pruned node, a rate limit, a call that now
   * succeeds because state moved — is `null`, which `evmErrorName` renders as
   * `UNKNOWN_REVERT:none`. The status is decided by the receipt and is not
   * touched here: a reason we could not recover must never become a success.
   */
  private async revertDataFor(
    client: EvmRelayClient,
    from: `0x${string}`,
    tx: { to: `0x${string}`; data?: `0x${string}` },
    blockNumber: bigint,
  ): Promise<string | null> {
    try {
      await client.call({ account: from, to: tx.to, data: tx.data ?? '0x', blockNumber });
      return null;
    } catch (error) {
      return revertDataOf(error);
    }
  }

  /**
   * The gas limit of a value transfer to `to`: 21 000 plus the L1 part, padded
   * 20 %. When `NodeInterface` does not answer, 21 000 plus
   * {@link EVM_VALUE_TRANSFER_FALLBACK_L1_GAS}.
   */
  private async valueTransferGas(chainId: ChainId, to: `0x${string}`): Promise<bigint> {
    const { l1Gas, l2BaseFee } = await estimateL1Gas(this.clientFor(chainId), {
      to,
      data: '0x',
      account: this.accountFor(chainId).address,
    });
    if (l2BaseFee === null) return EVM_VALUE_TRANSFER_GAS + EVM_VALUE_TRANSFER_FALLBACK_L1_GAS;
    return EVM_VALUE_TRANSFER_GAS + paddedL1Gas(l1Gas);
  }

  /** {@link warnIfFloatLow}, for a path that is already failing: never throws. */
  private async warnIfFloatLowQuietly(chainId: ChainId): Promise<void> {
    try {
      await this.warnIfFloatLow(chainId);
    } catch {
      // The refusal is the answer; the alert is a courtesy.
    }
  }

  /**
   * The float is the whole loss budget, so it has to be visible before it is
   * empty.
   *
   * `ONCE_PER_INCIDENT`: an empty relayer otherwise produces one alert per
   * attempted send, which is how a channel gets muted — and a muted channel
   * costs every other alert on it its audience.
   */
  private async warnIfFloatLow(chainId: ChainId): Promise<void> {
    if (this.lowWaterMarkWei <= 0n) {
      return;
    }
    const balance = await this.balanceWei(chainId);
    if (balance >= this.lowWaterMarkWei) {
      return;
    }
    await this.alerts.emit({
      severity: AlertSeverity.WARN,
      name: 'evm_relayer_float_low',
      summary: `The EVM ${this.identity.key}'s ETH float on ${chainId} is below its low-water mark`,
      details: {
        chainId,
        key: this.identity.key,
        // Strings: a wei figure does not fit a double, and `Number(balance)`
        // would round the one number this alert exists to report.
        balanceWei: balance.toString(),
        lowWaterMarkWei: this.lowWaterMarkWei.toString(),
        [this.identity.key]: this.accountFor(chainId).address,
      },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      // The chain id ALONE. `SuppressingAlertSink` keys on
      // `name:dedupeKey`, so the old `evm_relayer_float_low:${chainId}` put the
      // name in twice — harmless on its own, but `EvmRelayerFloatMonitor` emits
      // the same alert name for the same condition on the same chain from its
      // 5-minute pass, and two spellings of the key are two suppression buckets
      // for one incident. One condition, one bucket — per KEY: the redeemer's
      // float is a second condition with its own bucket (`floatDedupeKey`).
      dedupeKey: floatDedupeKey(chainId, this.identity.key),
    });
  }

  /**
   * The `to` address, checked against the chain the caller named.
   *
   * `to` is CAIP-10 and carries its own chain, so a mismatch means the call was
   * assembled from two sources. Sending it anyway puts the platform's gas behind
   * an address nobody checked on this chain.
   */
  private addressOnChain(chainId: ChainId, to: AccountId): `0x${string}` {
    const parsed = parseAccountId(to);
    if (parsed.chainId !== chainId) {
      throw ChainErrors.invalidAccountId({ value: `${to} is not on ${chainId}` });
    }
    return parsed.address as `0x${string}`;
  }

  private accountId(chainId: ChainId): AccountId {
    return `${chainId}:${this.accountFor(chainId).address}` as AccountId;
  }

  private accountFor(chainId: ChainId): PrivateKeyAccount {
    const account = this.#accounts.get(chainId);
    if (!account) {
      throw ChainErrors.programNotConfigured({
        what: `a ${this.identity.key} key for ${chainId}`,
        variable: this.identity.keysVariable,
      });
    }
    return account;
  }

  private clientFor(chainId: ChainId): EvmRelayClient {
    const client = this.clients.get(chainId);
    if (!client) {
      throw ChainErrors.programNotConfigured({
        what: `a JSON-RPC client for ${chainId}`,
        variable: 'EVM_RPC_URLS',
      });
    }
    return client;
  }
}
