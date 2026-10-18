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

import { ChainErrors } from '../errors/chains.errors';
import { AssetId, ChainId, chainIdOf, parseAccountId, toAccountId } from '../ports/caip.types';
import {
  HELD_STATUS_BY_INDEX,
  X402_CONFIG_HOLD_ABI,
  X402_ESCROW_HOLD_ABI,
} from './abi/x402-hold.abi';
import { X402_ESCROW_ABI } from './abi/x402.abi';
import { EvmDeployment } from './evm.constants';
import { EvmReaderClient } from './evm-escrow-balance-reader.service';
import { isRevert } from './evm-voucher-authority';
import { EVM_REDEEMER, EvmRelayerPort } from './ports/evm-relayer.port';

/** Gas for one held move, and for each further one in a batch. */
const HELD_BASE_GAS = 120_000n;
const HELD_PER_ITEM_GAS = 60_000n;

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
  ...X402_ESCROW_HOLD_ABI.filter((item) => item.type === 'event'),
  ...X402_ESCROW_ABI.filter((item) => item.type === 'event' && item.name === 'VoucherRedeemed'),
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
 * The escrow's held payments on eip155 (G3.B1, `x402-hold.abi.ts`). Sends with
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
        abi: X402_ESCROW_HOLD_ABI,
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
          abi: X402_ESCROW_HOLD_ABI,
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
          abi: X402_CONFIG_HOLD_ABI,
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
            abi: X402_ESCROW_HOLD_ABI,
            functionName: single,
            args: [payers[0], seqs[0]],
          })
        : encodeFunctionData({
            abi: X402_ESCROW_HOLD_ABI,
            functionName: batch,
            args: [payers, seqs],
          });
    const gasLimit = HELD_BASE_GAS + HELD_PER_ITEM_GAS * BigInt(keys.length - 1);
    // `eth_call` first, as the redeemer, with the gas it will be sent with: a
    // refusal (pause, blocklist, wrong status, timing) costs nothing.
    const sender = getAddress(parseAccountId(await this.redeemer.address(chainId)).address);
    try {
      await this.client(chainId).readContract({
        address: getAddress(this.deployment(chainId).escrow),
        abi: X402_ESCROW_HOLD_ABI,
        functionName: keys.length === 1 ? single : batch,
        args: keys.length === 1 ? [payers[0], seqs[0]] : [payers, seqs],
        account: sender,
        gas: gasLimit,
      } as Parameters<EvmReaderClient['readContract']>[0]);
    } catch (error) {
      if (isRevert(error)) throw new HeldSendRefusedError((error as Error).message.slice(0, 200));
      throw error;
    }
    const result = await this.redeemer.sendCall({
      chainId,
      to: toAccountId(chainId, getAddress(this.deployment(chainId).escrow)),
      data,
      gasLimit,
      purpose: `${keys.length === 1 ? single : batch} n=${keys.length}`,
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
