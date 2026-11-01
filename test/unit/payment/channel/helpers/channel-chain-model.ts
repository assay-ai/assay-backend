/**
 * Ported from the final review 2026-11-01 (money-flow). A faithful in-memory port of the ChannelDoor library's collect / refund
 * bucket rules (assay-evm `.wt/evm-p2-channels`, src/libraries/ChannelDoor.sol
 * `_collectOne` / `_refundOne`), plus fakes wiring the REAL backend services
 * (`ChannelSettlementService`, `ChannelRefundService`) to it.
 *
 * Only the money rules are modelled: one channel, the two buckets, the payer
 * balance, provider / treasury receipts, refundIds.
 */
import { getAddress } from 'viem';

import { VoucherChannelStatus } from '@database/postgres/entities/voucher-channel.entity';
import { DEFAULT_CHANNEL_POLICY } from '@modules/payment/domain/channel/channel-policy';
import { ChannelSlot } from '@modules/payment/domain/channel/channel-voucher';
import { ChannelRefundService } from '@modules/payment/services/channel-refund.service';
import { ChannelSettlementService } from '@modules/payment/services/channel-settlement.service';

export const CHAIN = 'eip155:46630';
export const ASSET = `${CHAIN}/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac`;
export const PAYER = getAddress(`0x${'aa'.repeat(20)}`);
export const PROVIDER = getAddress(`0x${'bb'.repeat(20)}`);
export const TREASURY = getAddress(`0x${'ee'.repeat(20)}`);
export const KEY = `0x${'0c'.repeat(32)}` as `0x${string}`;
export const GRID = 3_600;
export const HELD_TIMEOUT = 7 * 24 * 3_600;

export class ChainModel {
  slot: ChannelSlot;
  /** block.timestamp used when a tx executes. */
  execNow: number;
  balance = 0n;
  provider = 0n;
  treasury = 0n;
  /** Money collected by a stranger (permissionless after the timeout). */
  strangerCollected = 0n;
  readonly refunded = new Set<string>();
  /** `ChannelRefunded` logs by refundId (what `findRefundLanding` finds). */
  readonly landings = new Map<string, { txRef: string; amount: bigint }>();
  txCount = 0;

  constructor(slot: ChannelSlot, now: number) {
    this.slot = { ...slot };
    this.execNow = now;
  }

  get held(): bigint {
    return this.slot.h1 + this.slot.h2;
  }

  /** `_collectOne`, one channel. `wait` = 0 for the redeemer, HELD_TIMEOUT for anyone. */
  collect(keepHeld: bigint, byRedeemer = true): { m: number; take: bigint; fee: bigint }[] {
    const sl = { ...this.slot } as { -readonly [K in keyof ChannelSlot]: ChannelSlot[K] };
    const now = this.execNow;
    const wait = byRedeemer ? 0 : HELD_TIMEOUT;
    if (!byRedeemer && keepHeld !== 0n) throw new Error('NotRedeemer');
    const p1 = sl.h1 !== 0n && sl.m1 * GRID + wait <= now;
    const p2 = sl.h2 !== 0n && sl.m2 * GRID + wait <= now;
    const payable = (p1 ? sl.h1 : 0n) + (p2 ? sl.h2 : 0n);
    if (payable <= keepHeld) return [];
    let pay = payable - keepHeld;
    const paid: { m: number; take: bigint; fee: bigint }[] = [];
    const firstIsOne = p1 && (!p2 || sl.m1 <= sl.m2);
    for (let k = 0; k < 2 && pay > 0n; k += 1) {
      const one = (k === 0) === firstIsOne;
      if (one ? !p1 : !p2) continue;
      const h = one ? sl.h1 : sl.h2;
      const take = h < pay ? h : pay;
      const r = BigInt(one ? sl.r1 : sl.r2);
      const fee = (take * r) / 10_000n;
      const m = one ? sl.m1 : sl.m2;
      if (one) {
        sl.h1 = h - take;
        if (sl.h1 === 0n) [sl.m1, sl.r1] = [0, 0];
      } else {
        sl.h2 = h - take;
        if (sl.h2 === 0n) [sl.m2, sl.r2] = [0, 0];
      }
      pay -= take;
      paid.push({ m, take, fee });
      if (byRedeemer) this.provider += take - fee;
      else this.strangerCollected += take - fee;
      this.treasury += fee;
    }
    this.slot = sl;
    return paid;
  }

  /** `_refundOne`. Returns the skip reason, or null when refunded. */
  refund(m: number, r: number, amount: bigint, refundId: string): string | null {
    if (amount === 0n) return null;
    if (this.refunded.has(refundId)) return 'AlreadyRefunded';
    const sl = { ...this.slot } as { -readonly [K in keyof ChannelSlot]: ChannelSlot[K] };
    const one = sl.h1 !== 0n && sl.m1 === m && sl.r1 === r;
    if (!one && !(sl.h2 !== 0n && sl.m2 === m && sl.r2 === r)) return 'NoSuchBucket';
    if (this.execNow >= m * GRID + HELD_TIMEOUT) return 'WindowClosed';
    const h = one ? sl.h1 : sl.h2;
    if (amount > h) return 'Insufficient';
    if (one) {
      sl.h1 = h - amount;
      if (sl.h1 === 0n) [sl.m1, sl.r1] = [0, 0];
    } else {
      sl.h2 = h - amount;
      if (sl.h2 === 0n) [sl.m2, sl.r2] = [0, 0];
    }
    this.slot = sl;
    this.refunded.add(refundId);
    this.landings.set(refundId, { txRef: `0xrefund${this.txCount}`, amount });
    this.balance += amount;
    return null;
  }
}

export interface Row {
  organizationId: string;
  intentId: string;
  status: string;
  cumulative: bigint;
  calls: number;
  price: bigint;
  holdOpen: boolean;
  heldStatus: string | null;
  disputeOutcome: string | null;
  collectableAt: Date | null;
  createdAt: Date;
  settlementId: string | null;
  lapsed: boolean;
  holdId: string | null;
  closed: boolean;
  everLapsed: boolean;
}

export function row(id: string, cumulative: bigint, price: bigint, extra: Partial<Row> = {}): Row {
  return {
    organizationId: 'org',
    intentId: id,
    status: 'SETTLED',
    cumulative,
    calls: 1,
    price,
    holdOpen: true,
    heldStatus: 'HELD',
    disputeOutcome: null,
    collectableAt: null,
    createdAt: new Date(0),
    settlementId: null,
    lapsed: false,
    holdId: `hold-${id}`,
    closed: false,
    everLapsed: false,
    ...extra,
  };
}

/**
 * The real ChannelSettlementService + ChannelRefundService over the model.
 * `chainNowRead` is what `door.chainNow` answers (the pass start); the model's
 * `execNow` is the block time a send executes at.
 */
export function wire(
  model: ChainModel,
  rows: Row[],
  lane: Record<string, unknown> = {},
  over: { door?: Record<string, unknown>; channels?: Record<string, unknown> } = {},
) {
  const alerts: { severity: string; name: string; summary: string }[] = [];
  const clock = { chainNowRead: model.execNow };
  let txn = 0;
  /** `channel_txs`, in memory: one live (PENDING/SENT/LANDED) refund per call. */
  const txs = new Map<string, any>();
  const live = (t: any) => ['PENDING', 'SENT', 'LANDED'].includes(t.status);
  const laneRow = {
    id: 'lane-1',
    chainId: CHAIN,
    assetId: ASSET,
    payer: `${CHAIN}:${PAYER}`,
    signer: `${CHAIN}:${PAYER}`,
    providerAccount: `${CHAIN}:${PROVIDER}`,
    providerId: 'provider-1',
    organizationId: 'org',
    channelId: `0x${'5a'.repeat(32)}`,
    channelKey: KEY,
    status: VoucherChannelStatus.OPEN,
    statusReason: null,
    lastAcceptedCumulative: '999999999',
    lastAcceptedCalls: 99,
    settledCumulative: String(model.slot.settled),
    settledCalls: model.slot.calls,
    settlingTo: null,
    signerValidUntil: null,
    deadlineAt: null,
    urgentRequestedAt: null,
    lastSkipReason: null,
    ...lane,
  };
  const channels: any = {
    manager: { transaction: async (fn: any) => fn({}) },
    findInFlight: async () => [],
    listActive: async () => [laneRow],
    findById: async () => laneRow,
    calls: async () => rows.map((r) => ({ ...r })),
    vouchers: async () => [],
    cadenceOf: async () => new Map(),
    setDeadline: async () => undefined,
    clearUrgent: async () => undefined,
    findInFlightTxs: async () => [],
    findUnbookedCollects: async () => [],
    markTxBooked: async () => undefined,
    collectedByTx: async () => 0n,
    insertTx: async (input: any) => {
      if (
        input.kind === 'REFUND' &&
        [...txs.values()].some((t) => t.intentId === input.intentId && live(t))
      ) {
        return null;
      }
      const id = `tx-${++txn}`;
      txs.set(id, {
        id,
        intentId: null,
        ...input,
        txRefs: [],
        status: 'PENDING',
        createdAt: new Date(model.execNow * 1000),
        refundedAmount: null,
      });
      return id;
    },
    appendTxRef: async (id: string, hash: string) => {
      const tx = txs.get(id);
      if (!tx.txRefs.includes(hash)) tx.txRefs.push(hash);
      tx.status = 'SENT';
    },
    finishTx: async (
      id: string,
      status: string,
      _d: string | null,
      txRef?: string,
      refunded?: any,
    ) => {
      const tx = txs.get(id);
      if (!['PENDING', 'SENT'].includes(tx.status)) return;
      tx.status = status;
      if (txRef && !tx.txRefs.includes(txRef)) tx.txRefs.push(txRef);
      if (refunded) {
        tx.refundedAmount = refunded.amount;
        tx.pieces = refunded.pieces;
      }
    },
    findLiveRefund: async (intentId: string) =>
      [...txs.values()].find((t) => t.intentId === intentId && live(t)) ?? null,
    refundRecords: async (intentId: string) =>
      [...txs.values()].filter((t) => t.intentId === intentId),
    recordUnpaid: async () => undefined,
    setLastSkip: async (_id: string, reason: string | null) => {
      laneRow.lastSkipReason = reason as never;
    },
    closeUnsettled: async () => [],
    claimRequests: async () => [],
    markClaimed: async () => undefined,
    recordCollected: async () => undefined,
    markPaidOut: async () => undefined,
    refreshSettlementTotals: async () => 0,
    closeIdle: async () => 0,
    setStatus: async (_id: string, status: string) => {
      laneRow.status = status as never;
    },
    withRefundLock: async (_id: string, fn: () => Promise<unknown>) => fn(),
    releasedTo: async () => [],
    lapse: async () => 0,
    nearDeadline: async () => [],
    lastLandedRate: async () => null,
    ...over.channels,
  };
  const intents: any = {
    findById: async (_o: string, id: string) => {
      const r = rows.find((x) => x.intentId === id)!;
      return { ...r, price: { amount: String(r.price), asset: ASSET, decimals: 6 } };
    },
    bookHeldCollected: async (_o: string, id: string) => {
      const r = rows.find((x) => x.intentId === id)!;
      if (r.heldStatus === 'HELD') {
        r.heldStatus = 'COLLECTED';
        r.holdOpen = false;
      }
    },
    releaseHold: async () => undefined,
    bookBlockedProviderRefund: async () => ({ booked: true, disputeIds: [] }),
    resolve: async () => undefined,
  };
  const door: any = {
    doorLive: async () => true,
    chainNow: async () => clock.chainNowRead,
    collectHoldSeconds: async () => 3_600,
    takeRateBps: async () => 1_000,
    treasury: async () => TREASURY,
    isFrozen: async () => false,
    readBooks: async () => ({
      slot: { ...model.slot },
      unpaid: 0n,
      totalUnpaid: 0n,
      held: model.held,
    }),
    signerWindow: async () => ({
      validUntil: null,
      revoked: false,
      revokeGraceEndsAt: null,
      heldCapsEndAt: null,
    }),
    providerRisk: async () => ({
      unbonding: false,
      slashPending: false,
      nearFloor: false,
      blocked: false,
    }),
    collect: async (_a: unknown, _refs: unknown[], keep: bigint[]) => {
      model.txCount += 1;
      const paid = model.collect(keep[0]);
      return {
        txRef: `0xcollect${model.txCount}`,
        landedAt: model.execNow,
        paid: paid.map((p) => ({
          key: KEY,
          provider: PROVIDER,
          maturityHour: p.m,
          gross: p.take,
          fee: p.fee,
        })),
        skipped: [],
        deferred: [],
      };
    },
    refund: async (_a: unknown, items: any[]) => {
      model.txCount += 1;
      const refunded: any[] = [];
      const skipped: any[] = [];
      for (const item of items) {
        const why = model.refund(item.maturityHour, item.takeRateBps, item.amount, item.refundId);
        if (why === null) {
          refunded.push({
            key: KEY,
            payer: PAYER,
            maturityHour: item.maturityHour,
            takeRateBps: item.takeRateBps,
            amount: item.amount,
            refundId: item.refundId,
          });
        } else {
          skipped.push({
            key: KEY,
            reason: why,
            amount: item.amount,
            maturityHour: item.maturityHour,
            takeRateBps: item.takeRateBps,
          });
        }
      }
      return { txRef: `0xrefund${model.txCount}`, landedAt: model.execNow, refunded, skipped };
    },
    findRefundLanding: async (_a: unknown, _k: unknown, refundId: string) => {
      const found = model.landings.get(refundId);
      return found ? { txRef: found.txRef, blockNumber: 1n, amount: found.amount } : null;
    },
    ...over.door,
  };
  const alertPort = {
    emit: async (a: any) =>
      void alerts.push({ severity: a.severity, name: a.name, summary: a.summary }),
  };
  const settlement = new ChannelSettlementService(
    channels,
    intents,
    door,
    alertPort as never,
    new Set([CHAIN]),
    DEFAULT_CHANNEL_POLICY,
    null,
    () => clock.chainNowRead * 1000,
    null,
    null,
  );
  const refunds = new ChannelRefundService(channels, door, () => model.execNow * 1000);
  return { settlement, refunds, alerts, clock, laneRow, channels, intents, door, txs };
}
