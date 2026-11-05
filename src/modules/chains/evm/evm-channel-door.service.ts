import { Injectable, Logger } from '@nestjs/common';
import {
  concatHex,
  decodeEventLog,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  pad,
  parseAbi,
} from 'viem';

import {
  ChannelBooks,
  ChannelDoorPort,
  ChannelNotSentError,
  ChannelRefInput,
  ChannelSendDeferredError,
  ChannelSendOptions,
  ChannelTxReceipt,
  ChannelTxResult,
  CollectResult,
  ForeignChannelTx,
  NonceAndReceipts,
  ProviderRisk,
  SignerWindow,
  RefundItem,
  RefundLanding,
  RefundResult,
  SendLane,
  SettleItem,
  SettleItemOutcome,
  SettleResult,
} from '@modules/payment/ports/channel-door.port';
import {
  bucketId,
  bucketOf,
  COLLECT_SKIP_REASONS,
  REFUND_SKIP_REASONS,
  settleSkipReason,
  unpackChannelSlot,
} from '@modules/chains/evm/eip712/channel-voucher';

import { ChainErrors } from '../errors/chains.errors';
import { AssetId, ChainId, chainIdOf, parseAccountId, toAccountId } from '../ports/caip.types';
import { ASSAY_CONFIG_HOLD_ABI } from './abi/assay-hold.abi';
import { ASSAY_CONFIG_ABI, ASSAY_ESCROW_ABI, ASSAY_STAKE_ABI } from './abi/assay.abi';
import {
  CHANNEL_DOOR_ABI,
  LEGACY_CHANNEL_SETTLED_ABI,
  TOKEN_FREEZE_ABI,
} from './abi/channel-door.abi';
import { evmErrorName, revertDataOf } from './abi/error-selectors';
import { EvmDeployment } from './evm.constants';
import { EvmReaderClient } from './evm-escrow-balance-reader.service';
import {
  backgroundSendCharge,
  backgroundSendVerdict,
  estimateL1Gas,
  paddedL1Gas,
} from './evm-l1-gas';
import { EvmRedeemerHourlyBudget } from './evm-redeemer-hourly-budget';
import { receiptCostWei } from './evm-hourly-wei-budget';
import { EvmSendFloat, fitsBudget } from './evm-send-float';
import {
  EvmSendRejectedError,
  isInsufficientFunds,
  isSendRejected,
} from './evm-send-rejected.error';
import { isRevert } from './evm-voucher-authority';
import { EvmRelayerPort } from './ports/evm-relayer.port';

/** `CapsHeld` (escrow storage): the end of a caps hold, and of a revoked grant's grace. */
const CAPS_HELD_ABI = parseAbi([
  'event CapsHeld(address indexed payer, address indexed delegate, uint64 maxVoucherAmount, uint64 maxPerWindow, uint64 until)',
]);
/** How far back a `CapsHeld` is looked for: well past `TIGHTEN_DELAY` (3 h) on any chain in use. */
const CAPS_LOOKBACK_BLOCKS = 200_000n;
/** The caps-hold lookback is read in pages of this many blocks (ops F7: providers cap ranges). */
const CAPS_LOG_PAGE_BLOCKS = 50_000n;
/** A provider is "near the floor" below minimumStake × (1 + this / 10000). */
const STAKE_FLOOR_MARGIN_BPS = 2_500n;
const ZERO = '0x0000000000000000000000000000000000000000';

/** Settle: about 60–90k gas per item measured on the bench; fallbacks when the estimate fails. */
const SETTLE_FALLBACK_BASE_GAS = 200_000n;
const SETTLE_PER_ITEM_GAS = 110_000n;
const COLLECT_FALLBACK_BASE_GAS = 400_000n;
const COLLECT_PER_ITEM_GAS = 70_000n;
/**
 * `ChannelDoor.TRANSFER_GAS_FLOOR`: every payout transfer needs
 * `gasleft() >= 300_000 * 64 / 63 + 50_000`, checked inside the escrow's
 * DELEGATECALL, which itself forwards at most 63/64 of what is left.
 */
const TRANSFER_GAS_FLOOR = (300_000n * 64n) / 63n + 50_000n;
const TRANSFER_FLOOR_OUTSIDE_DELEGATE = (TRANSFER_GAS_FLOOR * 64n + 62n) / 63n;
/** One aggregated payout transfer (an ERC-20 transfer plus its events), with margin. */
const COLLECT_PAYOUT_GAS = 60_000n;
/** The collect's own work before its payouts. */
const COLLECT_WORK_BASE_GAS = 200_000n;

/**
 * A collect's gas when `eth_estimateGas` failed (final review 2026-11-01 X-8):
 * its work, one transfer per distinct payee (each provider once, plus the
 * treasury), and the transfer floor that must still be left at the last
 * payout. The floor is checked against `gasleft()`, not consumed per payout,
 * so it counts once.
 */
export function collectFallbackGas(distinctProviders: number): { base: bigint; perItem: bigint } {
  const payees = BigInt(Math.max(1, distinctProviders) + 1);
  return {
    base: COLLECT_WORK_BASE_GAS + TRANSFER_FLOOR_OUTSIDE_DELEGATE + COLLECT_PAYOUT_GAS * payees,
    perItem: COLLECT_PER_ITEM_GAS,
  };
}
/** The most a send's EXECUTION is given: per item, plus a base (collect pays a 300k stipend per payout). */
const MAX_BASE_GAS = 800_000n;
const MAX_PER_ITEM_GAS = 400_000n;
const ESTIMATE_NUM = 125n;
const ESTIMATE_DEN = 100n;

/**
 * A send's gas when `eth_estimateGas` failed, and `unconsumed`: the part of its
 * limit that must be available but is not burned.
 */
interface SendGasFallback {
  readonly base: bigint;
  readonly perItem: bigint;
  readonly unconsumed?: bigint;
}

type Log = { address: string; data: `0x${string}`; topics: readonly `0x${string}`[] };

interface ChannelClient extends EvmReaderClient {
  estimateContractGas?(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
    account: `0x${string}`;
  }): Promise<bigint>;
  getBlock?(args: {
    blockTag?: 'latest';
    blockNumber?: bigint;
  }): Promise<{ timestamp: bigint; number?: bigint | null }>;
  getTransactionReceipt?(args: {
    hash: `0x${string}`;
  }): Promise<{ status: string; blockNumber: bigint; logs: readonly Log[] } | null>;
  getTransaction?(args: { hash: `0x${string}` }): Promise<{ blockNumber: bigint | null } | null>;
  request?(args: { method: string; params: readonly unknown[] }): Promise<unknown>;
  /** One JSON-RPC batch (`createSanctionedEvmClient`): the results in call order. */
  rpcBatch?(calls: readonly { method: string; params: readonly unknown[] }[]): Promise<unknown[]>;
}

/** `findRefundLanding` reads the logs in pages of this many blocks. */
const REFUND_LOG_PAGE_BLOCKS = 10_000n;

/**
 * The channel door on eip155 (`ChannelDoorPort`), sent with the REDEEMER key
 * through the same float and hourly budget as redemptions and held moves.
 *
 * Every send is simulated first (`eth_call`, as the redeemer, with the gas it
 * is sent with): a calldata-level refusal costs nothing. A settle is ALSO
 * simulated per item where the node supports `eth_simulateV1`, which returns
 * the logs, so an item the chain would skip is dropped before the send (POLICY
 * §2.2); without it the scheduler's own base and bucket checks stand, and an
 * item the chain skips is read off the receipt and retried later.
 */
@Injectable()
export class EvmChannelDoor implements ChannelDoorPort {
  private readonly logger = new Logger(EvmChannelDoor.name);
  private readonly doorProbed = new Map<string, { live: boolean; at: number }>();

  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmReaderClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    private readonly redeemer: EvmRelayerPort,
    private readonly float: EvmSendFloat | null = null,
    private readonly hourly: Pick<
      EvmRedeemerHourlyBudget,
      'take' | 'takeDeadline' | 'settle' | 'paused'
    > | null = null,
    /**
     * The settlement token's issuer-freeze view, per chain
     * (`EVM_TOKEN_FREEZE_FUNCTIONS`, e.g. `{"eip155:4663":"isFrozen"}`). A chain
     * with none is never probed: "not known frozen". The mainnet USDG function
     * is not known yet and testnet USDG has none (assay-evm chain-facts §1).
     */
    private readonly freezeFunctions: ReadonlyMap<string, string> = new Map(),
  ) {}

  async doorLive(asset: AssetId): Promise<boolean> {
    const chainId = chainIdOf(asset);
    const cached = this.doorProbed.get(chainId);
    if (cached && (cached.live || Date.now() - cached.at < 60_000)) return cached.live;
    let live = false;
    try {
      live = (await this.readBooks(asset, `0x${'0'.repeat(64)}`)) !== null;
    } catch {
      live = false;
    }
    this.doorProbed.set(chainId, { live, at: Date.now() });
    return live;
  }

  async readBooks(
    asset: AssetId,
    key: `0x${string}`,
    to: `0x${string}` = '0x0000000000000000000000000000000000000000',
    blockNumber?: bigint,
  ): Promise<ChannelBooks | null> {
    const chainId = chainIdOf(asset);
    try {
      const [state, unpaid, totalUnpaid, held] = (await this.client(chainId).readContract({
        address: this.deployment(chainId).escrow,
        abi: CHANNEL_DOOR_ABI,
        functionName: 'channelBooks',
        args: [key, getAddress(to)],
        ...(blockNumber === undefined ? {} : { blockNumber }),
      } as Parameters<EvmReaderClient['readContract']>[0])) as readonly [
        bigint,
        bigint,
        bigint,
        bigint,
      ];
      return {
        slot: unpackChannelSlot(BigInt(state)),
        unpaid: BigInt(unpaid),
        totalUnpaid: BigInt(totalUnpaid),
        held: BigInt(held),
      };
    } catch (error) {
      if (isRevert(error)) return null;
      throw error;
    }
  }

  async chainNow(asset: AssetId): Promise<number> {
    const client = this.client(chainIdOf(asset)) as ChannelClient;
    if (typeof client.getBlock !== 'function') return Math.floor(Date.now() / 1000);
    return Number((await client.getBlock({ blockTag: 'latest' })).timestamp);
  }

  async chainHead(asset: AssetId): Promise<{ number: bigint; timestamp: number }> {
    const client = this.client(chainIdOf(asset)) as ChannelClient;
    if (typeof client.getBlock !== 'function')
      throw new Error('the chain client cannot read blocks');
    const block = await client.getBlock({ blockTag: 'latest' });
    if (block.number === null || block.number === undefined)
      throw new Error('the latest block has no number');
    return { number: BigInt(block.number), timestamp: Number(block.timestamp) };
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

  async takeRateBps(asset: AssetId): Promise<number> {
    const chainId = chainIdOf(asset);
    const params = (await this.client(chainId).readContract({
      address: this.deployment(chainId).config,
      abi: ASSAY_CONFIG_ABI,
      functionName: 'params',
      args: [],
    })) as { takeRateBps: number | bigint };
    return Number(params.takeRateBps);
  }

  async treasury(asset: AssetId): Promise<`0x${string}`> {
    const chainId = chainIdOf(asset);
    const params = (await this.client(chainId).readContract({
      address: this.deployment(chainId).config,
      abi: ASSAY_CONFIG_ABI,
      functionName: 'params',
      args: [],
    })) as { treasury: string };
    return getAddress(params.treasury);
  }

  /**
   * Fail-safe: `true` only on a confirmed freeze. No configured function, a
   * revert, an absent function or a read failure all read "not known frozen":
   * the collect goes ahead whatever this says (the contract sets a refused
   * payout aside in `unpaid`), so a wrong `false` costs nothing but the page.
   */
  async isFrozen(asset: AssetId, account: `0x${string}`): Promise<boolean> {
    const chainId = chainIdOf(asset);
    const fn = this.freezeFunctions.get(chainId);
    if (!fn || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(fn)) return false;
    try {
      const answer = await this.client(chainId).readContract({
        address: this.deployment(chainId).asset,
        abi: TOKEN_FREEZE_ABI(fn),
        functionName: fn,
        args: [getAddress(account)],
      });
      return answer === true;
    } catch {
      return false;
    }
  }

  async signerWindow(
    asset: AssetId,
    payer: `0x${string}`,
    signer: `0x${string}`,
  ): Promise<SignerWindow> {
    const chainId = chainIdOf(asset);
    const escrow = getAddress(this.deployment(chainId).escrow);
    const now = await this.chainNow(asset);
    const self = getAddress(payer) === getAddress(signer);
    let validUntil: number | null = null;
    let revoked = false;
    if (!self) {
      const delegation = (await this.client(chainId).readContract({
        address: escrow,
        abi: ASSAY_ESCROW_ABI,
        functionName: 'delegationOf',
        args: [getAddress(payer), getAddress(signer)],
      })) as { validUntil: bigint; revoked: boolean };
      validUntil = Number(delegation.validUntil) || null;
      revoked = Boolean(delegation.revoked);
    }
    // The running holds: the escrow's own (delegate 0) and, for a delegate, its own.
    const holds = await this.capsHolds(chainId, escrow, payer, self ? null : signer);
    const running = (delegate: string) =>
      holds
        .filter((h) => h.delegate === delegate && h.until > now)
        .reduce<number | null>((max, h) => (max === null || h.until > max ? h.until : max), null);
    const escrowHold = running(ZERO);
    const delegateHold = self ? null : running(getAddress(signer));
    let revokeGraceEndsAt: number | null = null;
    if (revoked) {
      // The revoke wrote a hold whose `until` is the grace end; none found → over now.
      const latest = holds
        .filter((h) => h.delegate === getAddress(signer))
        .reduce<number | null>((max, h) => (max === null || h.until > max ? h.until : max), null);
      revokeGraceEndsAt = latest !== null && latest > now ? latest : now;
    }
    const heldCaps = [escrowHold, revoked ? null : delegateHold].filter(
      (v): v is number => v !== null,
    );
    return {
      validUntil,
      revoked,
      revokeGraceEndsAt,
      heldCapsEndAt: heldCaps.length ? Math.min(...heldCaps) : null,
    };
  }

  private async capsHolds(
    chainId: ChainId,
    escrow: `0x${string}`,
    payer: `0x${string}`,
    delegate: `0x${string}` | null,
  ): Promise<{ delegate: string; until: number }[]> {
    const client = this.client(chainId) as unknown as {
      getBlockNumber?(): Promise<bigint>;
      getLogs?(args: {
        address: `0x${string}`;
        topics?: readonly (`0x${string}` | `0x${string}`[] | null)[];
        fromBlock: bigint;
        toBlock: bigint;
      }): Promise<readonly Log[]>;
    };
    if (typeof client.getLogs !== 'function' || typeof client.getBlockNumber !== 'function') {
      return [];
    }
    const latest = await client.getBlockNumber();
    const [topic0] = encodeEventTopics({ abi: CAPS_HELD_ABI, eventName: 'CapsHeld' });
    const topicOf = (address: string) => pad(getAddress(address)).toLowerCase() as `0x${string}`;
    const delegates = [topicOf(ZERO), ...(delegate ? [topicOf(delegate)] : [])];
    // Paged (ops F7): one 200k-block range is refused by many providers, and a
    // refusal leaves the round without the caps-hold end.
    const floor = latest > CAPS_LOOKBACK_BLOCKS ? latest - CAPS_LOOKBACK_BLOCKS : 0n;
    const logs: Log[] = [];
    for (let to = latest; to >= floor; ) {
      const from = to - CAPS_LOG_PAGE_BLOCKS + 1n > floor ? to - CAPS_LOG_PAGE_BLOCKS + 1n : floor;
      logs.push(
        ...(await client.getLogs({
          address: escrow,
          topics: [topic0, topicOf(payer), delegates],
          fromBlock: from,
          toBlock: to,
        })),
      );
      if (from === floor) break;
      to = from - 1n;
    }
    const out: { delegate: string; until: number }[] = [];
    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: CAPS_HELD_ABI,
          data: log.data,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        }) as unknown as { args: { delegate: string; until: bigint } };
        out.push({
          delegate: getAddress(decoded.args.delegate),
          until: Number(decoded.args.until),
        });
      } catch {
        // Not a CapsHeld.
      }
    }
    return out;
  }

  async providerRisk(asset: AssetId, provider: `0x${string}`): Promise<ProviderRisk> {
    const chainId = chainIdOf(asset);
    const deployment = this.deployment(chainId);
    const client = this.client(chainId);
    const [stake, params, blocked] = await Promise.all([
      client.readContract({
        address: deployment.stake,
        abi: ASSAY_STAKE_ABI,
        functionName: 'stakeOf',
        args: [getAddress(provider)],
      }) as Promise<{ bonded: bigint; unbonding: bigint; pendingSlash: bigint }>,
      client.readContract({
        address: deployment.config,
        abi: ASSAY_CONFIG_ABI,
        functionName: 'params',
        args: [],
      }) as Promise<{ minimumStake: bigint }>,
      client.readContract({
        address: deployment.config,
        abi: ASSAY_CONFIG_ABI,
        functionName: 'blocked',
        args: [getAddress(provider)],
      }) as Promise<boolean>,
    ]);
    const bonded = BigInt(stake.bonded);
    const pending = BigInt(stake.pendingSlash);
    const free = bonded > pending ? bonded - pending : 0n;
    const minimum = BigInt(params.minimumStake);
    return {
      unbonding: BigInt(stake.unbonding) > 0n,
      slashPending: pending > 0n,
      nearFloor: free * 10_000n < minimum * (10_000n + STAKE_FLOOR_MARGIN_BPS),
      blocked: blocked === true,
    };
  }

  async foreignChannelTxs(
    asset: AssetId,
    fromBlock: bigint | null,
    maxBlocks: bigint,
  ): Promise<{ toBlock: bigint; foreign: readonly ForeignChannelTx[] }> {
    const chainId = chainIdOf(asset);
    const escrow = getAddress(this.deployment(chainId).escrow);
    const client = this.client(chainId) as unknown as {
      getBlockNumber(): Promise<bigint>;
      getLogs(args: {
        address: `0x${string}`;
        fromBlock: bigint;
        toBlock: bigint;
      }): Promise<readonly (Log & { transactionHash: `0x${string}`; blockNumber: bigint })[]>;
      getTransaction(args: { hash: `0x${string}` }): Promise<{ from: `0x${string}` }>;
    };
    const latest = await client.getBlockNumber();
    // No cursor yet: from the recorded channel-door block when the deployment
    // names one (ops F13), so nothing between the upgrade and the first pass
    // goes unchecked; else the last `maxBlocks`.
    const recordedStart = this.deployment(chainId).channelDoorFromBlock;
    const start =
      fromBlock !== null
        ? fromBlock
        : recordedStart !== undefined
          ? recordedStart
          : latest > maxBlocks
            ? latest - maxBlocks
            : 0n;
    if (start > latest) return { toBlock: latest, foreign: [] };
    const toBlock = start + maxBlocks < latest ? start + maxBlocks : latest;
    const logs = await client.getLogs({ address: escrow, fromBlock: start, toBlock });
    const redeemer = await this.sender(chainId);
    const byTx = new Map<string, { events: string[]; blockNumber: bigint }>();
    for (const event of this.decodeWithTx(chainId, logs)) {
      const entry = byTx.get(event.txHash) ?? { events: [], blockNumber: event.blockNumber };
      entry.events.push(event.eventName);
      byTx.set(event.txHash, entry);
    }
    const foreign: ForeignChannelTx[] = [];
    for (const [txHash, entry] of byTx) {
      const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
      if (getAddress(tx.from) === redeemer) continue;
      foreign.push({
        txHash,
        from: getAddress(tx.from),
        events: entry.events,
        blockNumber: entry.blockNumber,
      });
    }
    return { toBlock, foreign };
  }

  /** The channel-door events among `logs`, with their transaction. */
  private decodeWithTx(
    chainId: ChainId,
    logs: readonly (Log & { transactionHash?: `0x${string}`; blockNumber?: bigint })[],
  ): { eventName: string; txHash: string; blockNumber: bigint }[] {
    const out: { eventName: string; txHash: string; blockNumber: bigint }[] = [];
    for (const log of logs) {
      const [decoded] = this.decode(chainId, [log]);
      if (!decoded || !CHANNEL_EVENT_NAMES.has(decoded.eventName) || !log.transactionHash) continue;
      out.push({
        eventName: decoded.eventName,
        txHash: log.transactionHash,
        blockNumber: BigInt(log.blockNumber ?? 0n),
      });
    }
    return out;
  }

  async simulateSettle(
    asset: AssetId,
    items: readonly SettleItem[],
  ): Promise<readonly SettleItemOutcome[]> {
    const chainId = chainIdOf(asset);
    const { data } = this.settleCall(items);
    const escrow = getAddress(this.deployment(chainId).escrow);
    const sender = await this.sender(chainId);
    const client = this.client(chainId) as ChannelClient;
    if (typeof client.request === 'function') {
      try {
        const result = (await client.request({
          method: 'eth_simulateV1',
          params: [
            {
              blockStateCalls: [{ calls: [{ from: sender, to: escrow, data }] }],
              validation: false,
            },
            'latest',
          ],
        })) as readonly { calls: readonly { status: string; logs: readonly Log[] }[] }[];
        const call = result?.[0]?.calls?.[0];
        if (call && (call.status === '0x1' || call.status === 'success')) {
          return this.decodeSettle(chainId, call.logs, items.length);
        }
        if (call) throw await this.refusal(chainId, 'settleChannels', data, sender);
      } catch (error) {
        if (error instanceof ChannelSendDeferredError) throw error;
        // No `eth_simulateV1` on this node: fall back to a plain `eth_call`.
      }
    }
    await this.assertCallPasses(chainId, 'settleChannels', data, sender);
    // Unknown per item: the caller's own checks stand, the receipt decides.
    return items.map((item, index) => ({
      kind: 'SETTLED' as const,
      index,
      key: '0x' as `0x${string}`,
      cumulative: item.voucher.cumulative,
      calls: item.voucher.calls,
      charge: item.charge,
      maturityHour: 0,
      takeRateBps: 0,
      opened: null,
      deferred: null,
    }));
  }

  async settle(
    asset: AssetId,
    items: readonly SettleItem[],
    lane: SendLane,
    options: ChannelSendOptions = {},
  ): Promise<SettleResult> {
    const chainId = chainIdOf(asset);
    const { data, args } = this.settleCall(items);
    const sent = await this.send(
      chainId,
      'settleChannels',
      data,
      args,
      items.length,
      lane,
      { base: SETTLE_FALLBACK_BASE_GAS, perItem: SETTLE_PER_ITEM_GAS },
      options,
    );
    return { ...sent, outcomes: this.decodeSettle(chainId, sent.logs, items.length) };
  }

  async collect(
    asset: AssetId,
    refs: readonly ChannelRefInput[],
    keep: readonly bigint[],
    lane: SendLane,
    options: ChannelSendOptions = {},
  ): Promise<CollectResult> {
    const chainId = chainIdOf(asset);
    const args = [refs.map(refArg), keep.map((value) => value)] as const;
    const data = encodeFunctionData({
      abi: CHANNEL_DOOR_ABI,
      functionName: 'collectChannels',
      args,
    });
    const sent = await this.send(
      chainId,
      'collectChannels',
      data,
      args,
      refs.length,
      lane,
      {
        ...collectFallbackGas(new Set(refs.map((ref) => getAddress(ref.provider))).size),
        unconsumed: TRANSFER_FLOOR_OUTSIDE_DELEGATE,
      },
      options,
    );
    const events = this.channelEvents(chainId, sent.logs);
    return {
      txRef: sent.txRef,
      landedAt: sent.landedAt,
      paid: events.collected,
      skipped: events.collectSkipped,
      deferred: events.deferred,
    };
  }

  /**
   * A recorded hash read back (review 2026-10-31 H1/H2): its receipt and the
   * channel events in it when mined; `PENDING` when the node still has it;
   * `UNKNOWN` when it has neither (dropped, or never broadcast).
   */
  async txReceipt(asset: AssetId, txRef: string): Promise<ChannelTxReceipt> {
    const chainId = chainIdOf(asset);
    const client = this.client(chainId) as ChannelClient;
    if (typeof client.getTransactionReceipt !== 'function') return { state: 'UNKNOWN' };
    const hash = txRef as `0x${string}`;
    const receipt = await client
      .getTransactionReceipt({ hash })
      .catch((error: unknown) => (isNotFound(error) ? null : Promise.reject(error)));
    if (!receipt) {
      if (typeof client.getTransaction !== 'function') return { state: 'UNKNOWN' };
      const tx = await client
        .getTransaction({ hash })
        .catch((error: unknown) => (isNotFound(error) ? null : Promise.reject(error)));
      return tx ? { state: 'PENDING' } : { state: 'UNKNOWN' };
    }
    let landedAt = Math.floor(Date.now() / 1000);
    if (typeof client.getBlock === 'function') {
      try {
        landedAt = Number((await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
      } catch {
        // The wall clock stands in.
      }
    }
    const success = receipt.status === 'success' || receipt.status === '0x1';
    const events = this.channelEvents(chainId, success ? receipt.logs : []);
    return {
      state: 'MINED',
      success,
      txRef,
      landedAt,
      settled: success ? this.decodeSettle(chainId, receipt.logs, null) : [],
      ...events,
    };
  }

  async confirmedNonce(asset: AssetId, from: `0x${string}`): Promise<bigint> {
    const client = this.client(chainIdOf(asset)) as unknown as {
      getTransactionCount(args: { address: `0x${string}`; blockTag: 'latest' }): Promise<number>;
    };
    return BigInt(
      await client.getTransactionCount({ address: getAddress(from), blockTag: 'latest' }),
    );
  }

  /**
   * The senders' confirmed nonces and the hashes' receipt states from ONE
   * JSON-RPC batch (one HTTP request, so one node behind a load balancer),
   * nonces first (sec-audit 2026-11-01 M-1). A client without batching, or a
   * node that refuses the batch, falls back to the reads one by one, nonces
   * first as before.
   */
  async nonceAndReceipts(
    asset: AssetId,
    senders: readonly `0x${string}`[],
    hashes: readonly string[],
  ): Promise<NonceAndReceipts> {
    const client = this.client(chainIdOf(asset)) as ChannelClient;
    const unique = [...new Set(senders.map((s) => getAddress(s)))];
    if (typeof client.rpcBatch === 'function') {
      let answers: readonly unknown[] | null = null;
      try {
        answers = await client.rpcBatch([
          ...unique.map((s) => ({ method: 'eth_getTransactionCount', params: [s, 'latest'] })),
          ...hashes.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] })),
          ...hashes.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] })),
        ]);
      } catch (error) {
        this.logger.debug(
          `batched nonce/receipt read failed, reading one by one: ${describeError(error)}`,
        );
      }
      if (answers && answers.length === unique.length + 2 * hashes.length) {
        const nonces = new Map<string, bigint>();
        unique.forEach((s, i) => nonces.set(s.toLowerCase(), BigInt(answers![i] as string)));
        const receipts = new Map<string, 'MINED' | 'PENDING' | 'UNKNOWN'>();
        hashes.forEach((h, i) => {
          const receipt = answers![unique.length + i];
          const tx = answers![unique.length + hashes.length + i];
          // A known transaction without a receipt (or a node mid-update) is
          // PENDING: it could still land, so it is never "dropped".
          receipts.set(h, receipt ? 'MINED' : tx ? 'PENDING' : 'UNKNOWN');
        });
        return { nonces, receipts };
      }
    }
    const nonces = new Map<string, bigint>();
    for (const s of unique) nonces.set(s.toLowerCase(), await this.confirmedNonce(asset, s));
    const receipts = new Map<string, 'MINED' | 'PENDING' | 'UNKNOWN'>();
    for (const h of hashes) receipts.set(h, (await this.txReceipt(asset, h)).state);
    return { nonces, receipts };
  }

  /**
   * The `ChannelRefunded` log of lane `key` with `refundId`, scanning back
   * from the latest block in pages of {@link REFUND_LOG_PAGE_BLOCKS}, at most
   * `maxBlocks`. `null` when not found (or the logs could not be read).
   */
  async findRefundLanding(
    asset: AssetId,
    key: `0x${string}`,
    refundId: `0x${string}`,
    maxBlocks: bigint,
  ): Promise<RefundLanding | null> {
    const chainId = chainIdOf(asset);
    const escrow = getAddress(this.deployment(chainId).escrow);
    const client = this.client(chainId) as unknown as {
      getBlockNumber(): Promise<bigint>;
      getLogs(args: {
        address: `0x${string}`;
        event: unknown;
        args: { key: `0x${string}` };
        fromBlock: bigint;
        toBlock: bigint;
      }): Promise<
        readonly (Log & { transactionHash: `0x${string}` | null; blockNumber: bigint | null })[]
      >;
    };
    if (typeof client.getLogs !== 'function') return null;
    const event = CHANNEL_DOOR_ABI.find(
      (item) => item.type === 'event' && item.name === 'ChannelRefunded',
    );
    try {
      const latest = BigInt(await client.getBlockNumber());
      const floor = latest > maxBlocks ? latest - maxBlocks : 0n;
      for (let to = latest; to >= floor; ) {
        const from =
          to - REFUND_LOG_PAGE_BLOCKS + 1n > floor ? to - REFUND_LOG_PAGE_BLOCKS + 1n : floor;
        const logs = await client.getLogs({
          address: escrow,
          event,
          args: { key },
          fromBlock: from,
          toBlock: to,
        });
        for (const log of logs) {
          const refunded = this.channelEvents(chainId, [log]).refunded[0];
          if (
            refunded &&
            refunded.key.toLowerCase() === key.toLowerCase() &&
            refunded.refundId === refundId.toLowerCase() &&
            log.transactionHash
          ) {
            return {
              txRef: log.transactionHash,
              blockNumber: BigInt(log.blockNumber ?? 0n),
              amount: refunded.amount,
            };
          }
        }
        if (from === floor) break;
        to = from - 1n;
      }
    } catch (error) {
      this.logger.warn(`refund landing of ${refundId} on ${key}: ${describeError(error)}`);
    }
    return null;
  }

  async latestBlock(asset: AssetId): Promise<bigint> {
    const client = this.client(chainIdOf(asset)) as unknown as {
      getBlockNumber(): Promise<bigint>;
    };
    return BigInt(await client.getBlockNumber());
  }

  /** The collect, refund and transfer events of one receipt. */
  private channelEvents(chainId: ChainId, logs: readonly Log[]) {
    const collected: CollectResult['paid'][number][] = [];
    const collectSkipped: { key: `0x${string}`; reason: string }[] = [];
    const deferred: CollectResult['deferred'][number][] = [];
    const refunded: RefundResult['refunded'][number][] = [];
    const refundSkipped: RefundResult['skipped'][number][] = [];
    for (const event of this.decode(chainId, logs)) {
      if (event.eventName === 'ChannelCollected') {
        collected.push({
          key: event.args.key as `0x${string}`,
          provider: getAddress(event.args.provider as string),
          maturityHour: Number(event.args.maturityHour),
          gross: BigInt(event.args.gross as bigint),
          fee: BigInt(event.args.fee as bigint),
        });
      } else if (event.eventName === 'ChannelCollectSkipped') {
        collectSkipped.push({
          key: event.args.key as `0x${string}`,
          reason:
            COLLECT_SKIP_REASONS[Number(event.args.reason)] ?? `Unknown(${event.args.reason})`,
        });
      } else if (event.eventName === 'TransferDeferred') {
        deferred.push({
          to: getAddress(event.args.to as string),
          amount: BigInt(event.args.amount as bigint),
        });
      } else if (event.eventName === 'ChannelRefunded') {
        const bucket = bucketOf(event.args.bucket as number);
        refunded.push({
          key: event.args.key as `0x${string}`,
          payer: getAddress(event.args.payer as string),
          maturityHour: bucket.maturityHour,
          takeRateBps: bucket.takeRateBps,
          amount: BigInt(event.args.amount as bigint),
          refundId: String(event.args.refundId).toLowerCase() as `0x${string}`,
        });
      } else if (event.eventName === 'ChannelRefundSkipped') {
        const bucket = bucketOf(event.args.bucket as number);
        refundSkipped.push({
          key: event.args.key as `0x${string}`,
          maturityHour: bucket.maturityHour,
          takeRateBps: bucket.takeRateBps,
          reason: REFUND_SKIP_REASONS[Number(event.args.reason)] ?? `Unknown(${event.args.reason})`,
          amount: BigInt(event.args.amount as bigint),
        });
      }
    }
    return { collected, collectSkipped, deferred, refunded, refundSkipped };
  }

  async refund(
    asset: AssetId,
    items: readonly RefundItem[],
    options: ChannelSendOptions = {},
  ): Promise<RefundResult> {
    const chainId = chainIdOf(asset);
    const args = [
      items.map((item) => refArg(item.ref)),
      items.map((item) => bucketId(item.maturityHour, item.takeRateBps)),
      items.map((item) => item.amount),
      items.map((item) => item.refundId),
    ] as const;
    const data = encodeFunctionData({
      abi: CHANNEL_DOOR_ABI,
      functionName: 'refundChannels',
      args,
    });
    // A refund keeps a buyer whole: it is never deferred by a fee spike.
    const sent = await this.send(
      chainId,
      'refundChannels',
      data,
      args,
      items.length,
      'URGENT',
      { base: COLLECT_FALLBACK_BASE_GAS, perItem: COLLECT_PER_ITEM_GAS },
      options,
    );
    const events = this.channelEvents(chainId, sent.logs);
    return {
      txRef: sent.txRef,
      landedAt: sent.landedAt,
      refunded: events.refunded,
      skipped: events.refundSkipped,
    };
  }

  async claimUnpaid(asset: AssetId, to: `0x${string}`): Promise<ChannelTxResult> {
    const chainId = chainIdOf(asset);
    const args = [getAddress(to)] as const;
    const data = encodeFunctionData({ abi: CHANNEL_DOOR_ABI, functionName: 'claimUnpaid', args });
    // One payout transfer: the same floor as a collect's (X-8).
    const sent = await this.send(chainId, 'claimUnpaid', data, args, 1, 'ORDINARY', {
      base: collectFallbackGas(1).base,
      perItem: 0n,
      unconsumed: TRANSFER_FLOOR_OUTSIDE_DELEGATE,
    });
    return { txRef: sent.txRef, landedAt: sent.landedAt };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private settleCall(items: readonly SettleItem[]) {
    const args = [
      items.map((item) => ({
        payer: item.voucher.payer,
        provider: item.voucher.provider,
        channelId: item.voucher.channelId,
        cumulative: item.voucher.cumulative,
        calls: item.voucher.calls,
        issuedAt: item.voucher.issuedAt,
        expiresAt: item.voucher.expiresAt,
      })),
      concatHex(items.map((item) => item.signature)),
      items.map((item) => item.fromSettled),
      items.map((item) => item.charge),
    ] as const;
    return {
      args,
      data: encodeFunctionData({ abi: CHANNEL_DOOR_ABI, functionName: 'settleChannels', args }),
    };
  }

  /**
   * Decodes a settle's logs into one outcome per item, in item order. `count`
   * `null` (a receipt read back without its batch): as many as the logs hold.
   */
  decodeSettle(chainId: ChainId, logs: readonly Log[], count: number | null): SettleItemOutcome[] {
    const outcomes: SettleItemOutcome[] = [];
    let pendingOpen: { key: string; signer: `0x${string}`; channelId: `0x${string}` } | null = null;
    let pendingDefer: { key: string; fromHour: number; toHour: number } | null = null;
    for (const event of this.decode(chainId, logs)) {
      const args = event.args;
      if (event.eventName === 'ChannelOpened') {
        pendingOpen = {
          key: String(args.key),
          signer: getAddress(args.signer as string),
          channelId: args.channelId as `0x${string}`,
        };
      } else if (event.eventName === 'ChannelBucketDeferred') {
        pendingDefer = {
          key: String(args.key),
          fromHour: Number(args.fromHour),
          toHour: Number(args.toHour),
        };
      } else if (event.eventName === 'ChannelSettled') {
        const key = String(args.key) as `0x${string}`;
        outcomes.push({
          kind: 'SETTLED',
          index: outcomes.length,
          key,
          cumulative: BigInt(args.cumulative as bigint),
          calls: Number(args.calls),
          charge: BigInt(args.charge as bigint),
          maturityHour: Number(args.maturityHour ?? args.m ?? 0),
          takeRateBps: Number(args.takeRateBps ?? args.r ?? 0),
          opened:
            pendingOpen && pendingOpen.key === key
              ? { signer: pendingOpen.signer, channelId: pendingOpen.channelId }
              : args.signer
                ? {
                    signer: getAddress(args.signer as string),
                    channelId: args.channelId as `0x${string}`,
                  }
                : null,
          deferred:
            pendingDefer && pendingDefer.key === key
              ? { fromHour: pendingDefer.fromHour, toHour: pendingDefer.toHour }
              : null,
        });
        pendingOpen = null;
        pendingDefer = null;
      } else if (event.eventName === 'ChannelSettleSkipped') {
        const key = String(args.key);
        outcomes.push({
          kind: 'SKIPPED',
          index: Number(args.index),
          key: /^0x0{64}$/.test(key) ? null : (key as `0x${string}`),
          cumulative: BigInt(args.cumulative as bigint),
          reason: settleSkipReason(Number(args.reason)),
        });
      }
    }
    // Items emit in order; `index` on a skip is authoritative, a settle takes its slot.
    const size = Math.max(
      count ?? outcomes.length,
      ...outcomes.filter((o) => o.kind === 'SKIPPED').map((o) => o.index + 1),
      0,
    );
    const ordered = new Array<SettleItemOutcome>(size);
    const skipped = new Set(outcomes.filter((o) => o.kind === 'SKIPPED').map((o) => o.index));
    let next = 0;
    for (const outcome of outcomes) {
      if (outcome.kind === 'SKIPPED') {
        ordered[outcome.index] = outcome;
        continue;
      }
      while (skipped.has(next)) next += 1;
      ordered[next] = { ...outcome, index: next };
      next += 1;
    }
    return ordered.filter((o) => o !== undefined);
  }

  private decode(
    chainId: ChainId,
    logs: readonly Log[],
  ): { eventName: string; args: Record<string, unknown> }[] {
    const escrow = getAddress(this.deployment(chainId).escrow);
    const out: { eventName: string; args: Record<string, unknown> }[] = [];
    for (const log of logs) {
      // Only the escrow's own logs: a library runs as the escrow (DELEGATECALL).
      if (getAddress(log.address) !== escrow) continue;
      for (const abi of [CHANNEL_DOOR_ABI, LEGACY_CHANNEL_SETTLED_ABI]) {
        try {
          const decoded = decodeEventLog({
            abi,
            data: log.data,
            topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
          }) as unknown as { eventName: string; args: Record<string, unknown> };
          out.push(decoded);
          break;
        } catch {
          // Not this event set.
        }
      }
    }
    return out;
  }

  private async send(
    chainId: ChainId,
    functionName: string,
    data: `0x${string}`,
    args: readonly unknown[],
    count: number,
    lane: SendLane,
    fallback: SendGasFallback,
    options: ChannelSendOptions = {},
  ): Promise<ChannelTxResult & { logs: readonly Log[] }> {
    // Everything before `sendCall` reads or decides; nothing is signed. A
    // failure there (an RPC error included) is a definite "not sent".
    let prepared: Awaited<ReturnType<EvmChannelDoor['prepare']>>;
    try {
      prepared = await this.prepare(chainId, functionName, data, args, count, lane, fallback);
    } catch (error) {
      if (
        error instanceof ChannelSendDeferredError ||
        error instanceof ChannelNotSentError ||
        isSendRejected(error)
      ) {
        throw error;
      }
      throw new ChannelNotSentError(`${functionName}: ${describeError(error)}`);
    }
    const { escrow, gasLimit, fee, maxFeePerGas, admission, purpose } = prepared;
    const client = this.client(chainId) as ChannelClient;
    let hookFailed: unknown = null;
    let result: Awaited<ReturnType<EvmRelayerPort['sendCall']>>;
    try {
      result = await this.redeemer.sendCall({
        chainId,
        to: toAccountId(chainId, escrow),
        data,
        gasLimit,
        purpose,
        boundQueueWait: true,
        ...(options.beforeBroadcast
          ? {
              beforeBroadcast: async (
                hash: `0x${string}`,
                signed?: { from: `0x${string}`; nonce: bigint },
              ) => {
                try {
                  await options.beforeBroadcast!(hash, signed);
                } catch (error) {
                  hookFailed = error;
                  throw error;
                }
              },
            }
          : {}),
      });
    } catch (error) {
      if (isInsufficientFunds(error)) this.float?.drained(chainId);
      // The hash could not be recorded: the relayer broadcast nothing.
      if (hookFailed !== null) {
        throw new ChannelNotSentError(`${functionName}: recording the hash failed`);
      }
      if (isSendRejected(error) || isRelayNotSent(error)) {
        throw new ChannelNotSentError(`${functionName}: ${describeError(error)}`);
      }
      // Anything else after signing (a timeout, a dropped connection) is an
      // UNKNOWN outcome: rethrown as it came, for the caller to read back.
      throw error;
    }
    if (maxFeePerGas !== null) this.float?.spent(chainId, gasLimit * maxFeePerGas);
    const actual = receiptCostWei(result, fee);
    if (actual !== null) await this.hourly?.settle(admission, actual);
    if (result.status !== 'SUCCESS') {
      // Mined and reverted: nothing changed on chain.
      throw new ChannelNotSentError(
        `${functionName} reverted: ${result.revertReason ?? 'unknown'} (${result.hash})`,
        result.hash,
      );
    }
    const receipt =
      typeof client.getTransactionReceipt === 'function'
        ? await client.getTransactionReceipt({ hash: result.hash as `0x${string}` })
        : null;
    let landedAt = Math.floor(Date.now() / 1000);
    if (typeof client.getBlock === 'function') {
      try {
        landedAt = Number((await client.getBlock({ blockNumber: result.blockNumber })).timestamp);
      } catch {
        // The wall clock stands in; landing reads its own block when it can.
      }
    }
    return { txRef: result.hash, landedAt, logs: receipt?.logs ?? [] };
  }

  /** The reads and decisions before a send: gas, fee verdict, float, simulation, budget. */
  private async prepare(
    chainId: ChainId,
    functionName: string,
    data: `0x${string}`,
    args: readonly unknown[],
    count: number,
    lane: SendLane,
    fallback: SendGasFallback,
  ) {
    const urgent = lane !== 'ORDINARY';
    if (lane !== 'DEADLINE' && this.hourly?.paused(chainId, urgent)) {
      throw new ChannelSendDeferredError(`the redeemer's hourly budget on ${chainId} is spent`);
    }
    const escrow = getAddress(this.deployment(chainId).escrow);
    const sender = await this.sender(chainId);
    const client = this.client(chainId) as ChannelClient;
    let estimate: bigint | null = null;
    try {
      if (typeof client.estimateContractGas === 'function') {
        estimate = BigInt(
          await client.estimateContractGas({
            address: escrow,
            abi: CHANNEL_DOOR_ABI,
            functionName,
            args,
            account: sender,
          }),
        );
      }
    } catch {
      // The simulation below says why.
    }
    const { l1Gas, l2BaseFee } = await estimateL1Gas(client, { to: escrow, data, account: sender });
    const extra = BigInt(Math.max(0, count - 1));
    let execution: bigint;
    if (estimate === null || estimate <= 0n) {
      execution = fallback.base + fallback.perItem * extra;
    } else {
      const bare = estimate > l1Gas ? estimate - l1Gas : estimate;
      const padded = (bare * ESTIMATE_NUM + ESTIMATE_DEN - 1n) / ESTIMATE_DEN;
      const ceiling = MAX_BASE_GAS + MAX_PER_ITEM_GAS * BigInt(count);
      execution = padded < ceiling ? padded : ceiling;
    }
    const gasLimit = execution + paddedL1Gas(l1Gas);
    // A fee spike defers only ordinary sends; a deadline or urgent send waives
    // the per-item cap, never the hard ceiling.
    //
    // Priced on the gas it will burn, not its limit: a collect's limit carries
    // the transfer floor, which `gasleft()` must reach and nothing consumes
    // (unused gas is not paid for). Priced on the limit, a one-lane collect at
    // 0.03 gwei read 18 uETH against a 10 uETH cap and waited on every pass,
    // while the same collect burned about 7 uETH (prod 2026-11-05).
    const unconsumed = fallback.unconsumed ?? 0n;
    const toBurn = unconsumed < execution ? gasLimit - unconsumed : gasLimit;
    const verdict = backgroundSendVerdict(toBurn, l2BaseFee, count, urgent);
    if (verdict === 'DEFER_CEILING' || verdict === 'DEFER') {
      throw new ChannelSendDeferredError(
        `${functionName} n=${count}: ${gasLimit} gas at ${l2BaseFee} wei is above the ` +
          `${verdict === 'DEFER' ? 'per-item cap' : 'hard ceiling'}`,
      );
    }
    let maxFeePerGas: bigint | null = null;
    if (this.float) {
      const budget = await this.float.budget(chainId, urgent);
      if (budget !== null && !fitsBudget(gasLimit, budget)) {
        throw new EvmSendRejectedError(
          'INSUFFICIENT_FUNDS',
          null,
          `the redeemer float on ${chainId} cannot pay ${functionName} at ${gasLimit} gas`,
        );
      }
      maxFeePerGas = budget?.maxFeePerGas ?? null;
    }
    await this.assertCallPasses(chainId, functionName, data, sender, gasLimit);
    const fee = l2BaseFee ?? maxFeePerGas;
    const charge = backgroundSendCharge(gasLimit, fee, null, count);
    const purpose = `${functionName} n=${count}`;
    const admission = this.hourly
      ? lane === 'DEADLINE'
        ? await this.hourly.takeDeadline(chainId, charge, purpose)
        : await this.hourly.take(chainId, charge, urgent, purpose)
      : { ticket: null };
    if (admission === null) {
      throw new ChannelSendDeferredError(`the redeemer's hourly budget on ${chainId} is spent`);
    }
    return { escrow, gasLimit, fee, maxFeePerGas, admission, purpose };
  }

  private async assertCallPasses(
    chainId: ChainId,
    functionName: string,
    data: `0x${string}`,
    sender: `0x${string}`,
    gas?: bigint,
  ): Promise<void> {
    const client = this.client(chainId) as unknown as {
      call?(args: {
        account: `0x${string}`;
        to: `0x${string}`;
        data: `0x${string}`;
        gas?: bigint;
      }): Promise<unknown>;
    };
    if (typeof client.call !== 'function') return;
    try {
      await client.call({
        account: sender,
        to: getAddress(this.deployment(chainId).escrow),
        data,
        ...(gas ? { gas } : {}),
      });
    } catch (error) {
      if (isRevert(error)) {
        const revert = revertDataOf(error);
        throw new ChannelSendDeferredError(
          `${functionName} would revert: ${revert ? evmErrorName(revert) : (error as Error).message.slice(0, 200)}`,
        );
      }
      throw error;
    }
  }

  private async refusal(
    chainId: ChainId,
    functionName: string,
    data: `0x${string}`,
    sender: `0x${string}`,
  ): Promise<ChannelSendDeferredError> {
    try {
      await this.assertCallPasses(chainId, functionName, data, sender);
    } catch (error) {
      if (error instanceof ChannelSendDeferredError) return error;
    }
    return new ChannelSendDeferredError(`${functionName} would revert`);
  }

  private async sender(chainId: ChainId): Promise<`0x${string}`> {
    return getAddress(parseAccountId(await this.redeemer.address(chainId)).address);
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

/** The events only the channel door emits (`TransferDeferred`/`UnpaidClaimed` included). */
const CHANNEL_EVENT_NAMES: ReadonlySet<string> = new Set([
  'ChannelSettled',
  'ChannelOpened',
  'ChannelBucketDeferred',
  'ChannelSettleSkipped',
  'ChannelCollected',
  'ChannelCollectSkipped',
  'ChannelRefunded',
  'ChannelRefundSkipped',
  'TransferDeferred',
  'UnpaidClaimed',
]);

/**
 * viem's "not found" for a receipt or a transaction: an answer, not a
 * failure. Only these two error types (re-review F2): a "method not found" or
 * an HTTP 404 body is a failure, never "no receipt".
 */
const NOT_FOUND_ERRORS: ReadonlySet<string> = new Set([
  'TransactionReceiptNotFoundError',
  'TransactionNotFoundError',
]);
function isNotFound(error: unknown): boolean {
  return NOT_FOUND_ERRORS.has((error as { name?: string } | null)?.name ?? '');
}

function isRelayNotSent(error: unknown): boolean {
  const tagged = error as { errorCode?: unknown } | null;
  return tagged?.errorCode === 'CHAIN_RELAY_NOT_SENT';
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

function refArg(ref: ChannelRefInput) {
  return {
    payer: getAddress(ref.payer),
    signer: getAddress(ref.signer),
    provider: getAddress(ref.provider),
    channelId: ref.channelId,
  };
}
