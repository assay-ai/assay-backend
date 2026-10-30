import { Inject, Injectable } from '@nestjs/common';
import { decodeEventLog, encodeFunctionData, getAddress } from 'viem';

import {
  HeldKey,
  HeldPaymentsPort,
  HeldRecord,
  HeldStatus,
  HeldTxResult,
  MAX_HELD_BATCH,
  RedemptionClass,
} from '@modules/payment/ports/held-payments.port';
import { FEE_SPIKE_DEFERRED } from '@modules/payment/ports/voucher-redeemer.port';

import { ChainErrors } from '../errors/chains.errors';
import { AssetId, ChainId, chainIdOf, parseAccountId, toAccountId } from '../ports/caip.types';
import {
  HELD_STATUS_BY_INDEX,
  ASSAY_CONFIG_HOLD_ABI,
  ASSAY_ESCROW_HOLD_ABI,
} from './abi/assay-hold.abi';
import { ASSAY_ESCROW_ABI } from './abi/assay.abi';
import { evmErrorName, revertDataOf } from './abi/error-selectors';
import { EvmDeployment } from './evm.constants';
import { EvmReaderClient } from './evm-escrow-balance-reader.service';
import {
  EVM_BACKGROUND_SEND_MAX_COST_WEI_PER_ITEM,
  estimateL1Gas,
  exceedsCostCap,
  paddedL1Gas,
} from './evm-l1-gas';
import { isRevert } from './evm-voucher-authority';
import { EVM_REDEEMER, EvmRelayerPort } from './ports/evm-relayer.port';

/**
 * The gas a held move is sent with is its execution — `eth_estimateGas` less the
 * L1 part — x 1.25, capped, plus the L1 part x 1.2 uncapped (`evm-l1-gas.ts`:
 * on Nitro the estimate carries the L1 posting cost, and a cap that cut it
 * refused sends as "out of gas at limit 520000 (estimate 609758)"). When the
 * estimate fails, a fixed execution limit: 180k for one move (a single collect
 * uses ~109k warm, ~126.5k when the treasury or the provider holds 0, ~144k
 * when both do; BUG-PROD-COLLECT-01), plus 60k for each further one in a batch.
 */
const HELD_FALLBACK_BASE_GAS = 180_000n;
const HELD_PER_ITEM_GAS = 60_000n;
/** The most a held move's EXECUTION is given, whatever the estimate says. */
const HELD_MAX_BASE_GAS = 400_000n;
const HELD_MAX_PER_ITEM_GAS = 120_000n;
/** The headroom over the estimate, as a ratio (125 / 100). */
const HELD_ESTIMATE_NUM = 125n;
const HELD_ESTIMATE_DEN = 100n;

/** The gas estimate this needs beyond `EvmReaderClient`. */
interface EstimateClient {
  estimateContractGas(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
    account: `0x${string}`;
  }): Promise<bigint>;
}

/** Whether a revert carried any return data (an out-of-gas revert carries none). */
function hasRevertData(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const node = current as { data?: unknown; raw?: unknown; signature?: unknown };
    if (typeof node.raw === 'string' && node.raw.length > 2) return true;
    if (typeof node.data === 'string' && node.data.length > 2) return true;
    if (node.data !== null && typeof node.data === 'object') return true;
    if (typeof node.signature === 'string' && node.signature.length > 2) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The receipt reads this needs beyond `EvmReaderClient`. */
interface ReceiptClient {
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{
    status: string;
    logs: readonly { address: string; data: `0x${string}`; topics: readonly `0x${string}`[] }[];
  } | null>;
}

/** The log reads the no-hash fallback needs beyond `EvmReaderClient`. */
interface LogsClient {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    address: `0x${string}`;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<
    readonly { address: string; data: `0x${string}`; topics: readonly `0x${string}`[] }[]
  >;
}

/** How far back the no-hash fallback looks for a redemption's logs. */
const LOG_LOOKBACK_BLOCKS = 50_000n;

/** The redemption events, to classify a receipt. */
const REDEMPTION_EVENTS_ABI = [
  ...ASSAY_ESCROW_HOLD_ABI.filter((item) => item.type === 'event'),
  ...ASSAY_ESCROW_ABI.filter((item) => item.type === 'event' && item.name === 'VoucherRedeemed'),
];

/** `EVM_HOLD_LIVE_CHAINS`: the CAIP-2 chains whose escrow has the hold (comma-separated). */
export function parseHoldLiveChains(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

/** A held move the chain would refuse (simulated, nothing sent). */
export class HeldSendRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`held send refused: ${reason}`);
    this.name = 'HeldSendRefusedError';
  }
}

/**
 * A held move NOT sent because the network's fees are briefly too high: the
 * limit at the L2 basefee is above `EVM_BACKGROUND_SEND_MAX_COST_WEI_PER_ITEM`
 * per record. Its message starts with {@link FEE_SPIKE_DEFERRED}, the reason the
 * row backs off with; the next pass tries again.
 */
export class HeldSendDeferredError extends Error {
  constructor(detail: string) {
    super(`${FEE_SPIKE_DEFERRED}: ${detail}`);
    this.name = 'HeldSendDeferredError';
  }
}

/**
 * The escrow's held payments on eip155 (G3.B1, `assay-hold.abi.ts`). Sends with
 * the REDEEMER key — the only sender `collectHeld` (before the timeout) and
 * `refundHeld` accept. A read that reverts means the escrow has no hold (not
 * yet upgraded): `null`, and the caller keeps the old pay-at-redemption path.
 */
@Injectable()
export class EvmHeldPayments implements HeldPaymentsPort {
  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmReaderClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    @Inject(EVM_REDEEMER) private readonly redeemer: EvmRelayerPort,
    private readonly liveChains: ReadonlySet<string> = new Set(),
  ) {}

  /** Chains whose escrow answered `totalHeld()`: the hold is there, for good. */
  private readonly supported = new Set<string>();
  /** When a chain last did NOT answer, so the probe is cheap (once a minute). */
  private readonly probedAt = new Map<string, number>();

  async holdLive(asset: AssetId): Promise<boolean> {
    const chainId = chainIdOf(asset);
    if (this.liveChains.has(chainId) || this.supported.has(chainId)) return true;
    const last = this.probedAt.get(chainId) ?? 0;
    if (Date.now() - last < 60_000) return false;
    this.probedAt.set(chainId, Date.now());
    try {
      if ((await this.totalHeld(asset)) !== null) {
        this.supported.add(chainId);
        return true;
      }
    } catch {
      // Unknown is not "no hold": the flag still decides, and the next probe asks again.
    }
    return false;
  }

  async classifyRedemption(
    asset: AssetId,
    txRef: string | null,
    key: HeldKey,
  ): Promise<RedemptionClass> {
    const chainId = chainIdOf(asset);
    const payer = getAddress(parseAccountId(key.payer).address);
    const seq = BigInt(key.seq);

    if (txRef && /^0x[0-9a-fA-F]{64}$/.test(txRef)) {
      const receipt = await (
        this.client(chainId) as unknown as ReceiptClient
      ).getTransactionReceipt({ hash: txRef as `0x${string}` });
      // A reverted transaction redeemed nothing: never PAID, never HELD.
      if (!receipt || receipt.status !== 'success') return { kind: 'UNKNOWN' };
      return this.classifyLogs(chainId, receipt.logs, payer, seq);
    }

    // No hash (a landing found but not observed): the record at the latest
    // block, then — bounded, review P2-6 of the second pass — the escrow's own
    // logs for this payer and seq over the recent blocks.
    const record = await this.readHeld(asset, key);
    if (record?.status === HeldStatus.HELD || record?.status === HeldStatus.COLLECTED) {
      return { kind: 'HELD', collectableAt: record.collectableAt };
    }
    const found = await this.findRedemptionLogs(chainId, payer, seq);
    if (found.kind !== 'UNKNOWN') return found;
    if (record === null && !(await this.holdLive(asset))) return { kind: 'PAID' };
    return { kind: 'UNKNOWN' };
  }

  /** The escrow's `PaymentHeld` / `VoucherRedeemed` for this payer and seq, recent blocks only. */
  private async findRedemptionLogs(
    chainId: ChainId,
    payer: `0x${string}`,
    seq: bigint,
  ): Promise<RedemptionClass> {
    const client = this.client(chainId) as unknown as LogsClient;
    if (typeof client.getLogs !== 'function' || typeof client.getBlockNumber !== 'function') {
      return { kind: 'UNKNOWN' };
    }
    const latest = await client.getBlockNumber();
    const logs = await client.getLogs({
      address: getAddress(this.deployment(chainId).escrow),
      fromBlock: latest > LOG_LOOKBACK_BLOCKS ? latest - LOG_LOOKBACK_BLOCKS : 0n,
      toBlock: latest,
    });
    return this.classifyLogs(chainId, logs, payer, seq);
  }

  /** Decides from logs: only those the ESCROW emitted, for this payer and seq. */
  private classifyLogs(
    chainId: ChainId,
    logs: readonly { address: string; data: `0x${string}`; topics: readonly `0x${string}`[] }[],
    payer: `0x${string}`,
    seq: bigint,
  ): RedemptionClass {
    const escrow = getAddress(this.deployment(chainId).escrow);
    {
      let redeemed = false;
      for (const log of logs) {
        if (getAddress(log.address) !== escrow) continue;
        let decoded: { eventName: string; args: Record<string, unknown> };
        try {
          decoded = decodeEventLog({
            abi: REDEMPTION_EVENTS_ABI,
            data: log.data,
            topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
          }) as unknown as { eventName: string; args: Record<string, unknown> };
        } catch {
          continue;
        }
        const samePayer = getAddress(String(decoded.args.payer)) === payer;
        const sameSeq = BigInt(decoded.args.seq as bigint) === seq;
        if (!samePayer || !sameSeq) continue;
        if (decoded.eventName === 'PaymentHeld') {
          return {
            kind: 'HELD',
            collectableAt: new Date(Number(decoded.args.collectableAt as bigint) * 1000),
          };
        }
        if (decoded.eventName === 'VoucherRedeemed') redeemed = true;
      }
      return redeemed ? { kind: 'PAID' } : { kind: 'UNKNOWN' };
    }
  }

  async readHeld(asset: AssetId, key: HeldKey): Promise<HeldRecord | null> {
    const chainId = chainIdOf(asset);
    try {
      const raw = (await this.client(chainId).readContract({
        address: this.deployment(chainId).escrow,
        abi: ASSAY_ESCROW_HOLD_ABI,
        functionName: 'held',
        args: [getAddress(parseAccountId(key.payer).address), BigInt(key.seq)],
      })) as {
        provider: string;
        amount: bigint;
        takeRateBps: number;
        status: number;
        collectableAt: bigint;
      };
      return {
        status: (HELD_STATUS_BY_INDEX[raw.status] ?? 'NONE') as HeldStatus,
        provider: raw.provider,
        amount: BigInt(raw.amount),
        takeRateBps: Number(raw.takeRateBps),
        collectableAt: new Date(Number(raw.collectableAt) * 1000),
      };
    } catch (error) {
      if (isRevert(error)) return null;
      throw error;
    }
  }

  collect(asset: AssetId, keys: readonly HeldKey[]): Promise<HeldTxResult> {
    return this.send(asset, keys, 'collectHeld', 'collectHeldBatch');
  }

  refund(asset: AssetId, keys: readonly HeldKey[]): Promise<HeldTxResult> {
    return this.send(asset, keys, 'refundHeld', 'refundHeldBatch');
  }

  async totalHeld(asset: AssetId): Promise<bigint | null> {
    const chainId = chainIdOf(asset);
    try {
      return BigInt(
        (await this.client(chainId).readContract({
          address: this.deployment(chainId).escrow,
          abi: ASSAY_ESCROW_HOLD_ABI,
          functionName: 'totalHeld',
          args: [],
        })) as bigint,
      );
    } catch (error) {
      if (isRevert(error)) return null;
      throw error;
    }
  }

  async collectHoldSeconds(asset: AssetId): Promise<number | null> {
    const chainId = chainIdOf(asset);
    try {
      return Number(
        (await this.client(chainId).readContract({
          address: this.deployment(chainId).config,
          abi: ASSAY_CONFIG_HOLD_ABI,
          functionName: 'collectHoldSeconds',
          args: [],
        })) as bigint,
      );
    } catch (error) {
      if (isRevert(error)) return null;
      throw error;
    }
  }

  private async send(
    asset: AssetId,
    keys: readonly HeldKey[],
    single: 'collectHeld' | 'refundHeld',
    batch: 'collectHeldBatch' | 'refundHeldBatch',
  ): Promise<HeldTxResult> {
    if (keys.length === 0 || keys.length > MAX_HELD_BATCH) {
      throw ChainErrors.payloadMalformed({
        reason: `a held batch of ${keys.length} is outside 1..${MAX_HELD_BATCH}`,
      });
    }
    const chainId = chainIdOf(asset);
    const payers = keys.map((key) => getAddress(parseAccountId(key.payer).address));
    const seqs = keys.map((key) => BigInt(key.seq));
    const data =
      keys.length === 1
        ? encodeFunctionData({
            abi: ASSAY_ESCROW_HOLD_ABI,
            functionName: single,
            args: [payers[0], seqs[0]],
          })
        : encodeFunctionData({
            abi: ASSAY_ESCROW_HOLD_ABI,
            functionName: batch,
            args: [payers, seqs],
          });
    const functionName = keys.length === 1 ? single : batch;
    const args = keys.length === 1 ? [payers[0], seqs[0]] : [payers, seqs];
    const escrow = getAddress(this.deployment(chainId).escrow);
    const sender = getAddress(parseAccountId(await this.redeemer.address(chainId)).address);
    const { gasLimit, estimate } = await this.gasFor(chainId, keys.length, data, {
      address: escrow,
      abi: ASSAY_ESCROW_HOLD_ABI,
      functionName,
      args,
      account: sender,
    });
    // `eth_call` first, as the redeemer, with the gas it will be sent with: a
    // refusal (pause, blocklist, wrong status, timing) costs nothing.
    try {
      await this.client(chainId).readContract({
        address: escrow,
        abi: ASSAY_ESCROW_HOLD_ABI,
        functionName,
        args,
        account: sender,
        gas: gasLimit,
      } as Parameters<EvmReaderClient['readContract']>[0]);
    } catch (error) {
      if (isRevert(error)) {
        // The `Errors.sol` name first when the node returned the selector: the
        // message alone may carry only the selector, or lose it to the cut.
        const data = revertDataOf(error);
        const message = (error as Error).message.slice(0, 200);
        throw new HeldSendRefusedError(
          data
            ? `${evmErrorName(data)}: ${message}`
            : hasRevertData(error)
              ? message
              : `out of gas at limit ${gasLimit} (estimate ${estimate ?? 'failed'})`,
        );
      }
      throw error;
    }
    const result = await this.redeemer.sendCall({
      chainId,
      to: toAccountId(chainId, escrow),
      data,
      gasLimit,
      purpose: `${functionName} n=${keys.length}`,
      // Never queue long behind the redemptions on the shared redeemer key:
      // give the send up, unsent, and let the next pass retry it.
      boundQueueWait: true,
    });
    if (result.status !== 'SUCCESS') {
      throw ChainErrors.payloadMalformed({
        reason: `${single} reverted: ${result.revertReason ?? 'unknown'} (${result.hash})`,
      });
    }
    return { txRef: result.hash };
  }

  /**
   * Execution (`eth_estimateGas` less the L1 part) x 1.25, capped — the fixed
   * fallback when the estimate fails — plus the L1 part x 1.2. Throws
   * {@link HeldSendDeferredError}, before any simulation or send, when that
   * limit would cost more than the per-record cap.
   */
  private async gasFor(
    chainId: ChainId,
    count: number,
    data: `0x${string}`,
    call: Parameters<EstimateClient['estimateContractGas']>[0],
  ): Promise<{ gasLimit: bigint; estimate: bigint | null }> {
    const extra = BigInt(count - 1);
    const client = this.client(chainId) as unknown as Partial<EstimateClient>;
    let estimate: bigint | null = null;
    try {
      if (typeof client.estimateContractGas === 'function') {
        estimate = BigInt(await client.estimateContractGas(call));
      }
    } catch {
      // A refusal or an outage: the fixed limit, and the pre-check says why.
    }
    const { l1Gas, l2BaseFee } = await estimateL1Gas(client, {
      to: call.address,
      data,
      account: call.account,
    });
    let execution: bigint;
    if (estimate === null || estimate <= 0n) {
      estimate = null;
      execution = HELD_FALLBACK_BASE_GAS + HELD_PER_ITEM_GAS * extra;
    } else {
      const ceiling = HELD_MAX_BASE_GAS + HELD_MAX_PER_ITEM_GAS * extra;
      const bare = estimate > l1Gas ? estimate - l1Gas : 0n;
      const padded = (bare * HELD_ESTIMATE_NUM + HELD_ESTIMATE_DEN - 1n) / HELD_ESTIMATE_DEN;
      execution = padded < ceiling ? padded : ceiling;
    }
    const gasLimit = execution + paddedL1Gas(l1Gas);
    const maxWei = EVM_BACKGROUND_SEND_MAX_COST_WEI_PER_ITEM * BigInt(count);
    if (exceedsCostCap(gasLimit, l2BaseFee, maxWei)) {
      throw new HeldSendDeferredError(
        `${gasLimit} gas (L1 ${l1Gas}) at ${l2BaseFee} wei is above the ${maxWei} wei cap; nothing was sent`,
      );
    }
    return { gasLimit, estimate };
  }

  private client(chainId: ChainId): EvmReaderClient {
    const client = this.clients.get(chainId);
    if (!client) throw ChainErrors.unsupportedChain({ chainId });
    return client;
  }

  private deployment(chainId: ChainId): EvmDeployment {
    const deployment = this.deployments.get(chainId);
    if (!deployment) throw ChainErrors.unsupportedChain({ chainId });
    return deployment;
  }
}
