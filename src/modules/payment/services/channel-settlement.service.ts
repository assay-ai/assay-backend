import { PaymentIntentStatus } from '../ports/payment.types';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import {
  ChannelSettlementEntity,
  ChannelSettlementStatus,
  ChannelTxKind,
  ChannelTxStatus,
  VoucherChannelEntity,
  VoucherChannelStatus,
} from '@database/postgres/entities/voucher-channel.entity';
import {
  CHANNEL_TERMINAL_STATUSES,
  ChannelCallRecord,
  VoucherChannelRepository,
} from '@database/postgres/repositories/voucher-channel.repository';
import { BlockedRole, BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { AssetId, chainIdOf, parseAccountId } from '@modules/chains/ports/caip.types';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { CHANNEL_LIVE_CHAINS, CHANNEL_POLICY } from '../constants/channel.constants';
import {
  DEBT_VOIDED_PREFIX,
  PROVIDER_FORFEIT_PREFIX,
} from '../constants/voucher-redemption.constants';
import {
  CHANNEL_HELD_TIMEOUT_SECONDS,
  ChannelCallRow,
  ChannelPending,
  ChannelPolicy,
  channelDeadline,
  chooseSettlement,
  AUTHORITY_LAPSED,
  classifyLapse,
  NO_BUCKET_DISPUTE_KEPT,
  decideRound,
  DEFAULT_CHANNEL_POLICY,
  DEFAULT_PAYOUT_CADENCE,
  laneOfTrigger,
  maturedAmount,
  newestUsableExpiry,
  PayoutCadence,
  payoutDue,
  placeCharge,
  RoundTrigger,
  SettleChoice,
  attributeCollect,
} from '../domain/channel/channel-policy';
import {
  CHANNEL_GRID_SECONDS,
  ChannelSlot,
  ChannelVoucherMessage,
  checksumAddress,
} from '../domain/channel/channel-voucher';
import {
  CHANNEL_DOOR,
  ChannelDoorPort,
  ChannelRefInput,
  ChannelSendDeferredError,
  channelSendNotSent,
  CollectBucketPaid,
  SendLane,
  SettleItem,
  SettleItemOutcome,
  SignerWindow,
  TransferDeferredEvent,
} from '../ports/channel-door.port';
import { ProviderSlashHoldRepository } from '@database/postgres/repositories/provider-slash-hold.repository';
import { ChannelRefundService } from './channel-refund.service';
import { DropWatch, droppedByNonce, recordSigned } from './channel-tx-attempts';
import { PaymentIntentService } from './payment-intent.service';

import {
  CHANNEL_TERMINAL_TIMEOUT_REASON,
  CHANNEL_TERMINAL_UNVERIFIED_REASON,
} from '../constants/channel.constants';

export { CHANNEL_TERMINAL_TIMEOUT_REASON, CHANNEL_TERMINAL_UNVERIFIED_REASON };

/**
 * Where a non-terminal channel call goes when `T_term` passes (the allowed
 * edges). A call the provider already answered (`VERIFYING`) is settled as
 * served and unverified, the per-call rule ("a served call is the buyer's to
 * pay"); only a call not served yet is voided or expired (review 2026-10-31
 * M2, decided pending owner sign-off — SPEC-W2 revision log).
 */
const TERMINAL_TIMEOUT_TARGET: Readonly<Record<string, PaymentIntentStatus>> = {
  CREATED: PaymentIntentStatus.EXPIRED,
  FUNDS_SECURED: PaymentIntentStatus.EXPIRED,
  PROVIDER_EXECUTING: PaymentIntentStatus.VOIDED,
  VERIFYING: PaymentIntentStatus.SETTLED,
};

/** Most items in one door transaction (`MAX_REDEEM_BATCH`). */
export const CHANNEL_MAX_BATCH = 64;
/** An in-flight settlement, collect or refund this old with no landing is read back from the chain. */
const READ_BACK_AFTER_SECONDS = 120;
/**
 * A send still unresolved this long after is paged as stuck. It is NOT
 * released on a timer: only once the sender's confirmed nonce is past every
 * recorded hash's nonce with no receipt (`droppedByNonce`).
 */
const STUCK_AFTER_SECONDS = 900;
/** Blocked-provider channel refunds per asset per pass (one transaction each). */
const MAX_BLOCKED_REFUNDS_PER_PASS = 16;
/** Alerts (SPEC-W2 §7). */
const UNSETTLED_WARN_SECONDS = 70 * 60;
const DEADLINE_CRITICAL_SECONDS = 45 * 60;
const PAUSE_ALERT_SECONDS = 3_600;
/** Consecutive failed passes (one a minute) that page CRITICAL (ops F2). */
export const PASS_FAILURES_CRITICAL = 3;
/** Channels assume a collect hold of at most an hour (contract L-1). */
const CHANNEL_MAX_EXPECTED_HOLD_SECONDS = 3_600;

/** Skip reasons that page (SPEC-W2 §7). */
const PAGED_SKIPS: ReadonlySet<string> = new Set([
  'Expired',
  'Authority',
  'Balance',
  'Stake',
  'NoBucket',
  'EscrowWindow',
  'DelegateWindow',
  'BaseMismatch',
  'PerCallCap',
  'Blocked',
  // Admission verified the signature: the chain refusing it is our bug (CRITICAL).
  'BadSignature',
]);

interface Planned {
  readonly channel: VoucherChannelEntity;
  readonly choice: SettleChoice;
  readonly settlementId: string;
  readonly item: SettleItem;
  readonly trigger: RoundTrigger | 'PIGGYBACK';
  readonly deadline: number | null;
}

/** A blocked party of a channel, as the platform blocklist says now. */
interface BlockedSide {
  readonly side: 'PAYER' | 'PROVIDER';
  /** The per-call door's name for it (`ProviderBlocked`, `PayeeBlocked`, `PayerBlocked`). */
  readonly cause: string;
}

/**
 * Per-channel alerts of one pass, aggregated per (name, reason) with a count
 * (review 2026-10-31 M6): an outage over N channels pages once, not N times.
 */
class AlertBatch {
  private readonly entries = new Map<
    string,
    { severity: AlertSeverity; name: string; reason: string; summary: string; keys: string[] }
  >();

  add(severity: AlertSeverity, name: string, reason: string, key: string, summary: string): void {
    const id = `${name}:${reason}`;
    const entry = this.entries.get(id);
    if (!entry) {
      this.entries.set(id, { severity, name, reason, summary, keys: [key] });
      return;
    }
    if (!entry.keys.includes(key)) entry.keys.push(key);
    if (severity === AlertSeverity.CRITICAL) entry.severity = severity;
  }

  drain() {
    const out = [...this.entries.values()];
    this.entries.clear();
    return out;
  }
}

/**
 * The channel settlement scheduler (spec P2 v3.1 §5.4 with SPEC-W2 §3), one
 * pass per asset with a channel per tick. In this order, all on CHAIN time:
 *
 * 1. **Land** what is in flight: a settlement or collect sent and not booked
 *    is read back — by its recorded hash (receipt, events) and `channelBooks`
 *    — and booked, or released only once the chain says it did not land. A
 *    send whose outcome is unknown (a receipt timeout, a crash) is NEVER
 *    released blindly (review 2026-10-31 H1/H2).
 * 2. **Recover** a channel the chain settled further than this database
 *    knows with nothing in flight: booked against the stored voucher at the
 *    chain's cumulative, with the calls the lost send charged.
 * 3. **Collect first** (SPEC-W2 §3): every ACTIVE channel with a matured
 *    bucket is collected before any settle, whatever the provider's cadence;
 *    IDLE channels on their provider's cadence (§8). A frozen provider or
 *    treasury is collected anyway (the contract sets the payout aside in
 *    `unpaid`, recorded and shown as unpaid) and paged. `keepHeld` = the
 *    disputed calls in matured buckets. A channel whose collect was put off
 *    (fees, budget) takes no non-deadline settle this pass (M5).
 * 4. **Blocklist** (H3/H4): a party on the platform blocklist is never
 *    settled or collected; a blocked provider's held calls are refunded to
 *    their buyers through the channel refund, and its unsettled calls are
 *    forfeited (buyer hold released), as on the per-call door.
 * 5. **Lapse**: served calls no stored voucher can settle any more, classified
 *    by the channel's last skip reason (H3): the provider's fault → forfeit;
 *    the buyer's → buyer debt (v3 §5.6); anything else → voided.
 * 6. **Round**: fires when any channel meets a trigger (deadline, hard cap,
 *    urgent request, provider risk, amount, age); then every channel with
 *    pending value joins (piggyback). The trigger picks the budget lane:
 *    DEADLINE → its own lane; hard cap, urgent (slash, drain, debt) and
 *    provider risk → URGENT; the rest ORDINARY (M1).
 * 7. **Send**: deadline items first; ≤ 64 items per transaction; each
 *    pre-simulated, the hash recorded before the broadcast.
 * 8. **Book** from the receipt, exactly the calls bound at plan time, once its
 *    key and cumulative match the plan (H2/L1/L2).
 *
 * The flag (`EVM_CHANNELS_LIVE_CHAINS`) gates NEW admission only (L7): every
 * existing channel keeps being settled, collected and refunded with it off.
 */
@Injectable()
export class ChannelSettlementService {
  private readonly logger = new Logger(ChannelSettlementService.name);
  /** Per payer: when its last urgent round ran (one per `urgentIntervalSeconds`). */
  private readonly urgentAt = new Map<string, number>();
  private pausedSince = new Map<string, number>();
  /** The take rate last seen per asset: a change drains every channel (SPEC-W2 §3). */
  private readonly lastRate = new Map<string, number>();
  /** Consecutive passes per asset that did not complete (ops F2). */
  private readonly failures = new Map<string, number>();
  private batch = new AlertBatch();

  constructor(
    private readonly channels: VoucherChannelRepository,
    private readonly intents: PaymentIntentService,
    @Inject(CHANNEL_DOOR) private readonly door: ChannelDoorPort,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Optional()
    @Inject(CHANNEL_LIVE_CHAINS)
    private readonly liveChains: ReadonlySet<string> = new Set(),
    @Optional()
    @Inject(CHANNEL_POLICY)
    private readonly policy: ChannelPolicy = DEFAULT_CHANNEL_POLICY,
    // This platform's own slash holds (a case in progress): a provider-risk input.
    @Optional() private readonly slashHolds: ProviderSlashHoldRepository | null = null,
    @Optional() private readonly now: () => number = () => Date.now(),
    // The channel refund (blocked providers' held calls). Absent: none are refunded here.
    @Optional() private readonly refunds: ChannelRefundService | null = null,
    // The platform blocklist, as the per-call passes read it (`RedemptionExclusions`).
    @Optional() private readonly blocklist: AccountBlocklistService | null = null,
  ) {
    this.drops = new DropWatch(this.now);
  }

  /** A settle or collect's DROPPED verdict must hold this long before it is released (M-1, B-S2). */
  private readonly drops: DropWatch;

  /**
   * The assets this pass covers: every eip155 asset with a channel still to
   * finish, or an unpaid claim asked for — whether or not its chain is live
   * for new channels (the flag gates admission only).
   */
  async assets(): Promise<AssetId[]> {
    const [active, claims] = await Promise.all([
      this.channels.activeAssets(),
      this.channels.assetsWithClaimRequests().catch(() => [] as string[]),
    ]);
    return [...new Set([...active, ...claims])].filter((asset) =>
      asset.startsWith('eip155:'),
    ) as AssetId[];
  }

  /** One pass over one asset. Never throws: a failed step is logged and the next one runs. */
  async run(asset: AssetId): Promise<void> {
    this.batch = new AlertBatch();
    let completed = false;
    try {
      if (!(await this.door.doorLive(asset))) {
        // `assets()` lists only assets with channels to finish: a door that
        // cannot be read is a failed pass, not a quiet one (ops F2).
        await this.passFailed(asset, 'the channel door could not be read');
        return;
      }
      if (!this.liveChains.has(chainIdOf(asset))) {
        this.logger.debug(`${asset}: channels not admitted (flag off); finishing existing ones`);
      }
      const [chainNow, hold, rate] = await Promise.all([
        this.door.chainNow(asset),
        this.door.collectHoldSeconds(asset),
        this.door.takeRateBps(asset),
      ]);
      await this.holdCheck(asset, hold);
      await this.landInFlight(asset, chainNow);
      await this.landCollects(asset);
      let channels = await this.channels.listActive(asset);
      let calls = await this.loadCalls(channels);
      // Channels whose chain books could not be read, or whose chain settled
      // value is ahead of the DB and was not booked: nothing of them lapses
      // this pass (rev3 L-1).
      const unresolved = new Set<string>();
      if (await this.recoverAhead(asset, channels, calls, chainNow, unresolved)) {
        channels = await this.channels.listActive(asset);
        calls = await this.loadCalls(channels);
      }
      const collectDeferred = new Set<string>();
      await this.collect(asset, channels, calls, chainNow, collectDeferred);
      await this.refundBlocked(asset, channels, calls, chainNow);
      await this.lapseUnsettleable(channels, calls, chainNow, unresolved);
      await this.round(asset, channels, calls, chainNow, hold ?? 3_600, rate, collectDeferred);
      await this.claims(asset);
      // The settlements' collected / refunded / left columns, from their calls (B-4).
      try {
        await this.channels.refreshSettlementTotals(asset);
      } catch (error) {
        this.logger.warn(`settlement totals on ${asset}: ${describe(error)}`);
      }
      await this.channels.closeIdle(asset);
      completed = true;
    } catch (error) {
      this.logger.error(`channel pass on ${asset} failed: ${describe(error)}`);
      await this.passFailed(asset, describe(error));
    } finally {
      if (completed) this.failures.delete(asset);
      await this.flush(asset);
    }
  }

  /**
   * A pass that did not complete (ops F2): counted per asset, CRITICAL from
   * {@link PASS_FAILURES_CRITICAL} in a row; and the deadline alert computed
   * from the database (`voucher_channels.deadline_at`), since the round that
   * normally raises it did not run.
   */
  private async passFailed(asset: AssetId, reason: string): Promise<void> {
    const failures = (this.failures.get(asset) ?? 0) + 1;
    this.failures.set(asset, failures);
    if (failures >= PASS_FAILURES_CRITICAL) {
      await this.alert(
        AlertSeverity.CRITICAL,
        'channel_pass_failing',
        `The channel settlement pass on ${asset} has failed ${failures} times in a row ` +
          `(${oneLine(reason)}): nothing is settled, collected or lapsed until it passes again.`,
        { asset, failures },
        `${asset}:pass_failing`,
      );
    }
    if (!this.policy.switches.perChannelAlerts) return;
    try {
      for (const key of await this.channels.nearDeadline(asset, DEADLINE_CRITICAL_SECONDS)) {
        this.batch.add(
          AlertSeverity.CRITICAL,
          'channel_deadline_near',
          'DEADLINE',
          key,
          `Unsettled channel value is less than 45 min from its deadline (from the database; the ` +
            `pass did not complete)`,
        );
      }
    } catch (error) {
      this.logger.warn(`deadline check on ${asset}: ${describe(error)}`);
    }
  }

  /**
   * The on-chain collect hold above one hour (contract L-1): channels are
   * offered only while it is at most an hour, but existing lanes keep settling
   * into buckets that long. Paged once per incident.
   */
  private async holdCheck(asset: AssetId, hold: number | null): Promise<void> {
    if (hold === null || hold <= CHANNEL_MAX_EXPECTED_HOLD_SECONDS) return;
    await this.alert(
      AlertSeverity.WARN,
      'channel_collect_hold_long',
      `The escrow's collect hold on ${asset} is ${hold} s (above ${CHANNEL_MAX_EXPECTED_HOLD_SECONDS} s): ` +
        `new channels are not offered and existing lanes settle into longer buckets. See the ` +
        `runbook: assay-deploy runbooks, channel incidents, "collect hold above one hour".`,
      { asset, hold },
      `${asset}:collect_hold:${hold}`,
    );
  }

  private async loadCalls(
    channels: readonly VoucherChannelEntity[],
  ): Promise<Map<string, ChannelCallRecord[]>> {
    const calls = new Map<string, ChannelCallRecord[]>();
    for (const channel of channels) {
      const rows = await this.channels.calls(channel.id);
      calls.set(
        channel.id,
        (await this.terminalTimeout(rows)) ? await this.channels.calls(channel.id) : rows,
      );
    }
    return calls;
  }

  // ── 0. Terminal timeout (v3 §5.4.1) ───────────────────────────────────────

  /**
   * A channel call not terminal within `T_term` (5 min) of its admission is
   * closed here, by the channel scheduler itself: a round settles only up to
   * the newest voucher whose own call and every earlier call are terminal
   * (I18), so one stuck call would hold every later call of its lane. A call
   * not served yet is never charged: unfunded EXPIRES, executing is VOIDED,
   * its buyer hold released. A call the provider already answered
   * (`VERIFYING`) is settled as served and unverified, as the per-call door
   * does at its verdict deadline. A verdict that lands first wins the
   * compare-and-set; this loses quietly. Returns whether it closed any.
   */
  private async terminalTimeout(rows: readonly ChannelCallRecord[]): Promise<boolean> {
    let closed = false;
    for (const row of rows) {
      const target = TERMINAL_TIMEOUT_TARGET[row.status];
      // ONE clock (sec-audit B-L2): the age the database computed from its own
      // `created_at` (`now() - created_at`), never the app clock against it.
      // In-memory records without it fall back to the app clock.
      const age =
        row.ageSeconds !== undefined && Number.isFinite(row.ageSeconds)
          ? row.ageSeconds
          : (this.now() - row.createdAt.getTime()) / 1000;
      if (!target || age < this.policy.terminalTimeoutSeconds) continue;
      try {
        if (target === PaymentIntentStatus.SETTLED) {
          const intent = await this.intents.findById(row.organizationId, row.intentId);
          await this.intents.resolve(
            row.organizationId,
            row.intentId,
            row.status as never,
            target,
            {
              reason: CHANNEL_TERMINAL_UNVERIFIED_REASON,
              ...(intent?.price ? { settledAmount: intent.price } : {}),
            },
          );
        } else {
          await this.intents.resolve(
            row.organizationId,
            row.intentId,
            row.status as never,
            target,
            {
              reason: CHANNEL_TERMINAL_TIMEOUT_REASON,
            },
          );
        }
        closed = true;
      } catch (error) {
        this.logger.debug(`terminal timeout of ${row.intentId} lost a race: ${describe(error)}`);
      }
    }
    return closed;
  }

  // ── 1. Landing read-back ─────────────────────────────────────────────────

  /**
   * Every settlement bound and not resolved. `channelBooks.settled` is the
   * authority: at the target → booked (from the receipt when one of its
   * recorded hashes has it, else from chain state); still at the start → the
   * recorded hashes decide: none recorded (never broadcast) or one mined
   * without settling it → released; otherwise released only once the
   * sender's confirmed nonce is past every recorded hash's nonce with no
   * receipt (`droppedByNonce`: none of them can land); until then kept in
   * flight, paged after {@link STUCK_AFTER_SECONDS}, never re-sent. Anything
   * else is the reconciler's.
   */
  private async landInFlight(asset: AssetId, chainNow: number): Promise<void> {
    for (const settlement of await this.channels.findInFlight(asset)) {
      try {
        await this.landOne(asset, settlement, chainNow);
      } catch (error) {
        this.logger.warn(`read-back of settlement ${settlement.id}: ${describe(error)}`);
      }
    }
  }

  private async landOne(
    asset: AssetId,
    settlement: ChannelSettlementEntity,
    chainNow: number,
  ): Promise<void> {
    const age = (this.now() - settlement.createdAt.getTime()) / 1000;
    if (age < READ_BACK_AFTER_SECONDS) return;
    const channel = await this.channels.findById(settlement.channelRowId);
    if (!channel) return;
    const books = await this.door.readBooks(asset, channel.channelKey as `0x${string}`);
    if (!books) return;
    const to = BigInt(settlement.toCumulative);
    const from = BigInt(settlement.fromSettled);
    const refs = settlement.txRefs ?? [];
    if (books.slot.settled === to) {
      const found = await this.receiptOutcome(asset, refs, channel.channelKey, to);
      await this.book(
        channel,
        settlement.id,
        found?.outcome ?? fromBooks(channel, settlement, books.slot),
        found?.txRef ?? refs[refs.length - 1] ?? 'read-back',
        found?.landedAt ?? chainNow,
      );
      return;
    }
    if (books.slot.settled !== from) {
      // The chain moved to a value this settlement does not explain: it can
      // no longer land as bound. Released; `recoverAhead` books a stored
      // voucher at the chain's value, the reconciler pages anything else.
      await this.channels.releaseSettlement(
        settlement.id,
        ChannelSettlementStatus.DROPPED,
        'chain moved',
      );
      return;
    }
    if (refs.length === 0) {
      // Bound, never handed a hash: nothing was broadcast.
      await this.channels.releaseSettlement(
        settlement.id,
        ChannelSettlementStatus.DROPPED,
        'never broadcast',
      );
      return;
    }
    let pending = false;
    for (const txRef of refs) {
      const receipt = await this.door.txReceipt(asset, txRef);
      if (receipt.state === 'PENDING') pending = true;
      if (receipt.state !== 'MINED') continue;
      // The books were read BEFORE this receipt: a send that landed in between
      // shows the settle here while the books still showed the start. Booked
      // from the receipt, never released (re-review L1).
      const landed = receipt.success
        ? receipt.settled.find(
            (o): o is Extract<SettleItemOutcome, { kind: 'SETTLED' }> =>
              o.kind === 'SETTLED' &&
              o.key.toLowerCase() === channel.channelKey.toLowerCase() &&
              o.cumulative === to,
          )
        : undefined;
      if (landed) {
        await this.book(channel, settlement.id, landed, txRef, receipt.landedAt);
        return;
      }
      // Mined and the chain still shows the start: it did not settle this item.
      const skip = receipt.settled.find(
        (o) =>
          o.kind === 'SKIPPED' &&
          (o.key === null || o.key.toLowerCase() === channel.channelKey.toLowerCase()) &&
          o.cumulative === to,
      );
      const reason =
        skip?.kind === 'SKIPPED' ? skip.reason : receipt.success ? 'not settled' : 'reverted';
      await this.channels.releaseSettlement(
        settlement.id,
        skip ? ChannelSettlementStatus.SKIPPED : ChannelSettlementStatus.DROPPED,
        reason,
      );
      if (skip?.kind === 'SKIPPED') {
        await this.skipped(asset, channel, skip.reason, settlement.id, `${from}→${to}`);
      } else {
        await this.channels.setLastSkip(channel.id, 'SEND_FAILED');
      }
      return;
    }
    if (pending) {
      this.drops.forget(`settle:${settlement.id}`);
      this.stuck(channel.channelKey, age);
      return;
    }
    const drop = await droppedByNonce(this.door, this.channels, asset, refs);
    // Released only once the verdict held for the wall-time gap (M-1, B-S2):
    // a lagging node behind a load balancer cannot release a landed send.
    if (this.drops.confirm(`settle:${settlement.id}`, drop.verdict)) {
      await this.channels.releaseSettlement(
        settlement.id,
        ChannelSettlementStatus.DROPPED,
        'nonce taken, no receipt',
      );
      await this.channels.setLastSkip(channel.id, 'SEND_FAILED');
      this.nonceTaken(channel.channelKey, drop.replacedBy);
      return;
    }
    this.stuck(channel.channelKey, age);
  }

  /** An unresolved send older than {@link STUCK_AFTER_SECONDS}: paged, never re-sent. */
  private stuck(key: string, ageSeconds: number): void {
    if (ageSeconds <= STUCK_AFTER_SECONDS) return;
    this.batch.add(
      AlertSeverity.WARN,
      'channel_tx_stuck',
      'UNRESOLVED',
      key,
      `A channel transaction has been unresolved for over 15 min (no receipt, its nonce not used ` +
        `yet); it is kept in flight and not re-sent`,
    );
  }

  /** Our recorded hashes lost their nonce to a transaction that is none of them: reported. */
  private nonceTaken(key: string, hashes: readonly string[]): void {
    this.batch.add(
      AlertSeverity.WARN,
      'channel_tx_nonce_taken',
      'REPLACED',
      key,
      `A channel transaction's nonce was used by another transaction (${hashes.slice(0, 2).join(', ')}); ` +
        `released as dropped. Check the redeemer key's other sends`,
    );
  }

  /** The settle outcome for `key` at `to` in one of the recorded receipts, if any. */
  private async receiptOutcome(
    asset: AssetId,
    refs: readonly string[],
    key: string,
    to: bigint,
  ): Promise<{
    outcome: Extract<SettleItemOutcome, { kind: 'SETTLED' }>;
    txRef: string;
    landedAt: number;
  } | null> {
    for (const txRef of refs) {
      let receipt;
      try {
        receipt = await this.door.txReceipt(asset, txRef);
      } catch {
        continue;
      }
      if (receipt.state !== 'MINED' || !receipt.success) continue;
      const outcome = receipt.settled.find(
        (o): o is Extract<SettleItemOutcome, { kind: 'SETTLED' }> =>
          o.kind === 'SETTLED' && o.key.toLowerCase() === key.toLowerCase() && o.cumulative === to,
      );
      if (outcome) return { outcome, txRef, landedAt: receipt.landedAt };
    }
    return null;
  }

  // ── 2. Chain ahead, nothing in flight ────────────────────────────────────

  /**
   * A channel whose chain `settled` is ahead of this database with nothing in
   * flight (a lost receipt whose settlement was released, or a late landing):
   * booked against the stored voucher at exactly the chain's cumulative, with
   * the calls the released settlement to that target charged (or, without
   * one, the served calls the rule charges). No such voucher, or a value
   * above what was accepted, is left to the reconciler (CRITICAL). Returns
   * whether anything was booked.
   */
  private async recoverAhead(
    asset: AssetId,
    channels: readonly VoucherChannelEntity[],
    calls: ReadonlyMap<string, ChannelCallRecord[]>,
    chainNow: number,
    unresolved: Set<string> = new Set(),
  ): Promise<boolean> {
    let recovered = false;
    for (const channel of channels) {
      if (channel.settlingTo !== null) continue;
      const settled = BigInt(channel.settledCumulative);
      const above = (calls.get(channel.id) ?? []).filter((row) => row.cumulative > settled);
      if (above.length === 0) continue;
      let books;
      try {
        books = await this.door.readBooks(asset, channel.channelKey as `0x${string}`);
      } catch {
        unresolved.add(channel.id);
        continue;
      }
      if (!books) {
        unresolved.add(channel.id);
        continue;
      }
      if (books.slot.settled <= settled) continue;
      // From here the chain is ahead of the DB: unresolved unless booked below.
      unresolved.add(channel.id);
      const chainSettled = books.slot.settled;
      if (chainSettled > BigInt(channel.lastAcceptedCumulative)) continue;
      const voucher = (await this.channels.vouchers(channel.id, settled)).find(
        (v) => BigInt(v.cumulative) === chainSettled,
      );
      if (!voucher) {
        this.batch.add(
          AlertSeverity.CRITICAL,
          'channel_chain_ahead_unknown',
          'NO_VOUCHER',
          channel.channelKey,
          `The chain settled channels to a cumulative no stored voucher has; not booked`,
        );
        continue;
      }
      const covered = above.filter((row) => row.cumulative <= chainSettled);
      // The released settlement whose recorded receipt shows this settle is
      // the one that landed (re-review L2); without any receipt, the only
      // candidate. Several candidates and no receipt: which calls the chain
      // charged is unknown — left to the reconciler.
      const candidates = await this.channels.releasedTo(channel.id, chainSettled);
      let released: (typeof candidates)[number] | null = null;
      let found: Awaited<ReturnType<ChannelSettlementService['receiptOutcome']>> = null;
      for (const candidate of candidates) {
        found = await this.receiptOutcome(
          asset,
          candidate.txRefs ?? [],
          channel.channelKey,
          chainSettled,
        );
        if (found) {
          released = candidate;
          break;
        }
      }
      if (!released && candidates.length > 1) {
        this.batch.add(
          AlertSeverity.CRITICAL,
          'channel_chain_ahead_unknown',
          'AMBIGUOUS',
          channel.channelKey,
          `The chain settled a channel to a target several released settlements bound, and no ` +
            `recorded receipt shows which one; not booked`,
        );
        continue;
      }
      released ??= candidates[0] ?? null;
      const chargedIds = released
        ? new Set(released.chargedIntentIds ?? [])
        : new Set(covered.filter((row) => chargeable(row)).map((row) => row.intentId));
      const charge = covered
        .filter((row) => chargedIds.has(row.intentId))
        .reduce((sum, row) => sum + row.price, 0n);
      const step = chainSettled - settled;
      if (charge > step) {
        this.batch.add(
          AlertSeverity.CRITICAL,
          'channel_settle_outcome_mismatch',
          'CHARGE_ABOVE_STEP',
          channel.channelKey,
          `A channel settle found on chain moved it by ${step}, its bound calls charge ${charge}; ` +
            `not booked`,
        );
        continue;
      }
      if (found && found.outcome.charge !== charge) {
        this.batch.add(
          AlertSeverity.CRITICAL,
          'channel_settle_outcome_mismatch',
          'CHARGE',
          channel.channelKey,
          `A channel settle found on chain charged ${found.outcome.charge}, its bound calls ` +
            `${charge}; not booked`,
        );
        continue;
      }
      const settlementId = await this.channels.bindSettlement({
        channelRowId: channel.id,
        voucherId: voucher.id,
        fromSettled: settled,
        toCumulative: chainSettled,
        fromCalls: channel.settledCalls,
        toCalls: voucher.calls,
        charge,
        waived: step - charge,
        trigger: 'RECOVER',
        intentIds: covered.map((row) => row.intentId),
        chargedIntentIds: [...chargedIds],
      });
      if (!settlementId) continue;
      unresolved.delete(channel.id);
      const newest = newestBucket(books.slot);
      await this.book(
        channel,
        settlementId,
        found?.outcome ?? {
          kind: 'SETTLED',
          index: 0,
          key: channel.channelKey as `0x${string}`,
          cumulative: chainSettled,
          calls: voucher.calls,
          charge,
          maturityHour: newest.m,
          takeRateBps: newest.r,
          opened: null,
          deferred: null,
        },
        found?.txRef ?? released?.txRefs?.[released.txRefs.length - 1] ?? 'recovered',
        found?.landedAt ?? chainNow,
      );
      this.batch.add(
        AlertSeverity.WARN,
        'channel_landing_recovered',
        'CHAIN_AHEAD',
        channel.channelKey,
        `A channel settlement found on chain with nothing in flight was booked from the stored voucher`,
      );
      recovered = true;
    }
    return recovered;
  }

  // ── 3. Collect first ─────────────────────────────────────────────────────

  private async collect(
    asset: AssetId,
    channels: readonly VoucherChannelEntity[],
    calls: ReadonlyMap<string, ChannelCallRecord[]>,
    chainNow: number,
    deferred: Set<string>,
  ): Promise<void> {
    const inFlight = new Set(
      (await this.channels.findInFlightTxs(asset, ChannelTxKind.COLLECT)).flatMap(
        (tx) => tx.channelRowIds,
      ),
    );
    const cadences = await this.channels.cadenceOf([...new Set(channels.map((c) => c.providerId))]);
    const due: { channel: VoucherChannelEntity; keep: bigint }[] = [];
    const readyByProvider = new Map<string, bigint>();
    const candidates: {
      channel: VoucherChannelEntity;
      keep: bigint;
      payable: bigint;
      active: boolean;
    }[] = [];
    for (const channel of channels) {
      // A collect already sent and not read back yet: never a second one.
      if (inFlight.has(channel.id)) {
        deferred.add(channel.id);
        continue;
      }
      // Never collected for (or from) a blocked party: the refund pass has it.
      if (this.blockedSide(channel)) continue;
      const held = (calls.get(channel.id) ?? []).filter((row) => row.heldStatus === 'HELD');
      if (held.length === 0) continue;
      const books = await this.door.readBooks(asset, channel.channelKey as `0x${string}`);
      if (!books) continue;
      const payable = maturedAmount(books.slot, chainNow);
      if (payable === 0n) continue;
      // EVERY held call with an open or upheld dispute is kept, whatever its
      // maturity (final review MF-2, fix review FR-M2). `chainNow` is read
      // once at the pass start, and a batch (or a collect whose receipt timed
      // out) can mine much later at `block.timestamp`, when a disputed
      // bucket may have matured. A maturity cut-off can therefore pay a
      // disputed call. Over-keeping only delays undisputed money by at most
      // one hold; under-keeping pays a disputed call.
      const keep = held
        .filter((row) => row.disputeOutcome === 'OPEN' || row.disputeOutcome === 'UPHELD')
        .reduce((sum, row) => sum + row.price, 0n);
      if (payable <= keep) continue;
      const active = BigInt(channel.lastAcceptedCumulative) > BigInt(channel.settledCumulative);
      candidates.push({ channel, keep, payable, active });
      readyByProvider.set(
        channel.providerId,
        (readyByProvider.get(channel.providerId) ?? 0n) + payable - keep,
      );
    }
    for (const candidate of candidates) {
      const cadence = (cadences.get(candidate.channel.providerId)?.cadence ??
        DEFAULT_PAYOUT_CADENCE) as PayoutCadence;
      const last = cadences.get(candidate.channel.providerId)?.lastPayoutAt ?? null;
      const idleDue = payoutDue(
        cadence,
        readyByProvider.get(candidate.channel.providerId) ?? 0n,
        last ? Math.floor(last.getTime() / 1000) : null,
        chainNow,
        this.policy.hourlyPayoutMinimumAtomic,
      );
      // Active channels: collect-first, unconditionally (SPEC-W2 §3).
      if ((candidate.active && this.policy.switches.collectFirst) || idleDue) {
        due.push({ channel: candidate.channel, keep: candidate.keep });
      }
    }
    if (due.length === 0) return;

    // Frozen recipients are collected anyway (their payout goes to `unpaid`), and paged.
    const treasury = await this.door.treasury(asset).catch(() => null);
    const frozen: string[] = [];
    for (const address of new Set([
      ...due.map((d) => addressOf(d.channel.providerAccount)),
      ...(treasury ? [treasury] : []),
    ])) {
      if (await this.door.isFrozen(asset, address as `0x${string}`).catch(() => false))
        frozen.push(address);
    }
    if (frozen.length > 0) {
      await this.alert(
        AlertSeverity.CRITICAL,
        'channel_payout_recipient_frozen',
        `Payout recipients frozen by the token issuer on ${asset}: ${frozen.join(', ')}. Collected anyway: ` +
          `the escrow sets their payout aside (unpaid), paid with claimUnpaid once the freeze lifts ` +
          `(override M-3).`,
        { asset, frozen },
        `${asset}:frozen`,
      );
    }

    for (let start = 0; start < due.length; start += CHANNEL_MAX_BATCH) {
      const batch = due.slice(start, start + CHANNEL_MAX_BATCH);
      const ids = batch.map((d) => d.channel.id);
      const txId = await this.channels.insertTx({
        kind: ChannelTxKind.COLLECT,
        assetId: asset,
        channelRowIds: ids,
      });
      if (!txId) continue;
      let result;
      try {
        result = await this.door.collect(
          asset,
          batch.map((d) => refOf(d.channel)),
          batch.map((d) => d.keep),
          'ORDINARY',
          {
            beforeBroadcast: async (hash, signed) => {
              await recordSigned(this.channels, hash, signed);
              await this.channels.appendTxRef(txId, hash);
            },
          },
        );
      } catch (error) {
        // Put off (fees, budget) or not sent: these channels take no
        // non-deadline settle this pass (M5). Unknown: kept SENT, read back.
        for (const id of ids) deferred.add(id);
        const putOff =
          error instanceof ChannelSendDeferredError && (await this.channels.discardUnsentTx(txId));
        if (!putOff && channelSendNotSent(error)) {
          await this.channels.finishTx(txId, ChannelTxStatus.DROPPED, 'not sent');
        }
        await this.sendFailed(asset, 'collectChannels', error);
        continue;
      }
      // LANDED before booking, `booked` after: a crash in between leaves the
      // collect LANDED and unbooked, re-booked from its receipt next pass
      // (`landCollects`, idempotent per row — re-review L3).
      await this.channels.finishTx(txId, ChannelTxStatus.LANDED, null, result.txRef);
      await this.bookCollect(
        asset,
        batch.map((d) => d.channel),
        calls,
        result.paid,
        result.deferred,
        result.txRef,
      );
      await this.channels.markTxBooked(txId);
      for (const skip of result.skipped) {
        this.batch.add(
          AlertSeverity.WARN,
          'channel_collect_skipped',
          skip.reason,
          skip.key,
          `Channel collect skipped on ${asset} (${skip.reason})`,
        );
      }
    }
  }

  /** Collects recorded and not resolved: read back by their hashes and booked. */
  private async landCollects(asset: AssetId): Promise<void> {
    for (const tx of await this.channels.findInFlightTxs(asset, ChannelTxKind.COLLECT)) {
      try {
        const age = (this.now() - tx.createdAt.getTime()) / 1000;
        if (age < READ_BACK_AFTER_SECONDS) continue;
        if (tx.txRefs.length === 0) {
          await this.channels.finishTx(tx.id, ChannelTxStatus.DROPPED, 'never broadcast');
          continue;
        }
        let pending = false;
        let done = false;
        for (const txRef of tx.txRefs) {
          const receipt = await this.door.txReceipt(asset, txRef);
          if (receipt.state === 'PENDING') pending = true;
          if (receipt.state !== 'MINED') continue;
          if (!receipt.success) {
            await this.channels.finishTx(tx.id, ChannelTxStatus.DROPPED, 'reverted');
          } else {
            await this.channels.finishTx(tx.id, ChannelTxStatus.LANDED, null, txRef);
            await this.bookLandedCollect(asset, tx.id, tx.channelRowIds, receipt, txRef);
          }
          done = true;
          break;
        }
        if (!done) {
          const drop = pending
            ? { verdict: 'IN_FLIGHT' as const, replacedBy: [] as string[] }
            : await droppedByNonce(this.door, this.channels, asset, tx.txRefs);
          if (this.drops.confirm(`collect:${tx.id}`, drop.verdict)) {
            await this.channels.finishTx(tx.id, ChannelTxStatus.DROPPED, 'nonce taken, no receipt');
            this.nonceTaken(`collect:${tx.id}`, drop.replacedBy);
          } else if (drop.verdict !== 'DROPPED') {
            this.stuck(`collect:${tx.id}`, age);
          }
        }
      } catch (error) {
        this.logger.warn(`read-back of collect ${tx.id}: ${describe(error)}`);
      }
    }
    // LANDED and not booked: the process stopped between the two (re-review
    // L3). Re-booked from the receipt; rows booked before the stop are not
    // attributed again (`bookCollect` subtracts them).
    for (const tx of await this.channels.findUnbookedCollects(asset)) {
      try {
        for (const txRef of [...tx.txRefs].reverse()) {
          const receipt = await this.door.txReceipt(asset, txRef);
          if (receipt.state !== 'MINED' || !receipt.success) continue;
          await this.bookLandedCollect(asset, tx.id, tx.channelRowIds, receipt, txRef);
          break;
        }
      } catch (error) {
        this.logger.warn(`re-booking of collect ${tx.id}: ${describe(error)}`);
      }
    }
  }

  /** Books a landed collect from its receipt, then marks it booked. */
  private async bookLandedCollect(
    asset: AssetId,
    txId: string,
    channelRowIds: readonly string[],
    receipt: {
      collected: readonly CollectBucketPaid[];
      deferred: readonly TransferDeferredEvent[];
    },
    txRef: string,
  ): Promise<void> {
    const channels = (
      await Promise.all(channelRowIds.map((id) => this.channels.findById(id)))
    ).filter((c): c is VoucherChannelEntity => c !== null);
    const calls = new Map<string, ChannelCallRecord[]>();
    for (const channel of channels) calls.set(channel.id, await this.channels.calls(channel.id));
    await this.bookCollect(asset, channels, calls, receipt.collected, receipt.deferred, txRef);
    await this.channels.markTxBooked(txId);
  }

  private async bookCollect(
    asset: AssetId,
    channels: readonly VoucherChannelEntity[],
    calls: ReadonlyMap<string, ChannelCallRecord[]>,
    paid: readonly CollectBucketPaid[],
    deferredTransfers: readonly TransferDeferredEvent[],
    txRef: string,
  ): Promise<void> {
    const providers = new Set<string>();
    for (const channel of channels) {
      const paidGross = paid
        .filter((p) => p.key.toLowerCase() === channel.channelKey.toLowerCase())
        .reduce((sum, p) => sum + p.gross, 0n);
      if (paidGross === 0n) continue;
      // Idempotent: what this collect already booked on the channel (a
      // re-booking after a stop) is not attributed again.
      const already = await this.channels.collectedByTx(channel.id, txRef);
      const gross = paidGross > already ? paidGross - already : 0n;
      if (gross === 0n) {
        providers.add(channel.providerId);
        continue;
      }
      const held = (calls.get(channel.id) ?? []).filter((row) => row.heldStatus === 'HELD');
      const { paid: rows, unattributed } = attributeCollect(
        held.map((row) => ({
          intentId: row.intentId,
          price: row.price,
          collectableAt: row.collectableAt ? Math.floor(row.collectableAt.getTime() / 1000) : 0,
          cumulative: row.cumulative,
          kept: row.disputeOutcome === 'OPEN' || row.disputeOutcome === 'UPHELD',
        })),
        gross,
      );
      for (const row of rows) {
        const record = held.find((h) => h.intentId === row.intentId)!;
        await this.intents.bookHeldCollected(record.organizationId, row.intentId, txRef);
      }
      if (unattributed > 0n) {
        this.batch.add(
          AlertSeverity.WARN,
          'channel_collect_unattributed',
          'UNATTRIBUTED',
          channel.channelKey,
          `A channel collect paid money no held call accounts for (tx ${txRef})`,
        );
      }
      await this.channels.recordCollected(channel.id);
      providers.add(channel.providerId);
    }
    await this.channels.markPaidOut([...providers]);
    // A refused payout transfer: booked as collected, but NOT in the wallet
    // (review 2026-10-31 M4) — recorded as unpaid until claimed.
    for (const transfer of deferredTransfers) {
      const address = transfer.to.toLowerCase();
      const owner = channels.find((c) => addressOf(c.providerAccount).toLowerCase() === address);
      await this.channels.recordUnpaid({
        assetId: asset,
        address,
        providerId: owner?.providerId ?? null,
        amount: transfer.amount,
        txRef,
      });
    }
    if (deferredTransfers.length > 0) {
      await this.alert(
        AlertSeverity.CRITICAL,
        'channel_transfer_deferred',
        `A channel payout transfer on ${asset} failed and was set aside in unpaid: ` +
          deferredTransfers.map((d) => `${d.to} ${d.amount}`).join(', ') +
          `. Shown to the provider as unpaid; claim it with override M-3 once the freeze lifts.`,
        { asset, txRef },
        `${asset}:${txRef}`,
      );
    }
  }

  // ── 4. Blocklist ─────────────────────────────────────────────────────────

  /**
   * The channel's blocked party, if any, from the platform blocklist the
   * per-call passes build their `RedemptionExclusions` from: the provider
   * (organization or payout wallet) first, then the payer side (the payer's
   * organization, the payer, a delegate signer).
   */
  private blockedSide(channel: VoucherChannelEntity): BlockedSide | null {
    if (!this.blocklist) return null;
    const provider = this.blocklist.firstBlocked([
      {
        role: BlockedRole.PROVIDER,
        kind: BlockSubjectKind.ORGANIZATION,
        subject: channel.providerId,
      },
      { role: BlockedRole.PAYEE, kind: BlockSubjectKind.WALLET, subject: channel.providerAccount },
    ]);
    if (provider) {
      return {
        side: 'PROVIDER',
        cause: provider.role === BlockedRole.PROVIDER ? 'ProviderBlocked' : 'PayeeBlocked',
      };
    }
    const payer = this.blocklist.firstBlocked([
      {
        role: BlockedRole.ORGANIZATION,
        kind: BlockSubjectKind.ORGANIZATION,
        subject: channel.organizationId,
      },
      { role: BlockedRole.PAYER, kind: BlockSubjectKind.WALLET, subject: channel.payer },
      ...(channel.signer.toLowerCase() !== channel.payer.toLowerCase()
        ? [{ role: BlockedRole.DELEGATE, kind: BlockSubjectKind.WALLET, subject: channel.signer }]
        : []),
    ]);
    return payer ? { side: 'PAYER', cause: 'PayerBlocked' } : null;
  }

  /**
   * A blocked provider's calls still in a bucket go back to their buyers, as
   * the per-call door's `refundBlocked` does: one channel refund per call
   * (idempotent per call), then booked as the provider's forfeit. Only while
   * the bucket's refund window is open; at most
   * {@link MAX_BLOCKED_REFUNDS_PER_PASS} per pass.
   */
  private async refundBlocked(
    asset: AssetId,
    channels: readonly VoucherChannelEntity[],
    calls: ReadonlyMap<string, ChannelCallRecord[]>,
    chainNow: number,
  ): Promise<void> {
    if (!this.refunds || !this.blocklist) return;
    let sent = 0;
    for (const channel of channels) {
      const blocked = this.blockedSide(channel);
      if (blocked?.side !== 'PROVIDER') continue;
      // Read again (final review MF-8): the pass's snapshot predates the
      // collect, and a call it booked COLLECTED must not be refunded out of
      // another call's bucket.
      let rows: readonly ChannelCallRecord[];
      try {
        rows = await this.channels.calls(channel.id);
      } catch (error) {
        this.logger.warn(`calls of ${channel.channelKey}: ${describe(error)}`);
        continue;
      }
      const held = rows.filter(
        (row) =>
          row.heldStatus === 'HELD' &&
          (row.collectableAt === null ||
            row.collectableAt.getTime() / 1000 + CHANNEL_HELD_TIMEOUT_SECONDS > chainNow),
      );
      for (const row of held) {
        if (sent >= MAX_BLOCKED_REFUNDS_PER_PASS) return;
        sent += 1;
        try {
          const outcome = await this.refunds.refund({
            assetId: asset,
            channelRowId: channel.id,
            amount: row.price,
            intentId: row.intentId,
          });
          if (outcome.kind === 'REFUNDED') {
            await this.intents.bookBlockedProviderRefund(
              row.organizationId,
              row.intentId,
              blocked.cause,
              outcome.txRef,
            );
          }
        } catch (error) {
          this.logger.warn(`blocked-provider refund of ${row.intentId}: ${describe(error)}`);
        }
      }
    }
  }

  // ── 5. Lapse ─────────────────────────────────────────────────────────────

  private async lapseUnsettleable(
    channels: readonly VoucherChannelEntity[],
    calls: ReadonlyMap<string, ChannelCallRecord[]>,
    chainNow: number,
    unresolved: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    for (const channel of channels) {
      const rows = calls.get(channel.id) ?? [];
      // A forfeit or void marked and not released yet (a crash in between).
      for (const row of rows.filter((r) => r.closed && r.holdOpen && r.holdId)) {
        await this.release(row.organizationId, row.intentId, row.holdId as string);
      }
      if (channel.settlingTo !== null) continue;
      // The chain could not be read, or it settled the channel past the DB and
      // that was not booked (read error, NO_VOUCHER, AMBIGUOUS, a mismatch): a
      // call the chain may have charged must not lapse into a buyer debt the
      // portal could then move per call (rev3 L-1). Next pass.
      if (unresolved.has(channel.id)) continue;
      const settled = BigInt(channel.settledCumulative);
      const served = rows.filter(
        (row) =>
          row.cumulative > settled &&
          row.status === 'SETTLED' &&
          row.holdOpen &&
          !row.heldStatus &&
          !row.lapsed &&
          !row.closed,
      );
      if (served.length === 0) continue;
      const vouchers = await this.channels.vouchers(channel.id, settled);
      const usable = vouchers.filter((v) => Number(v.expiresAt) + 7_200 > chainNow);
      const reach = usable.reduce(
        (max, v) => (BigInt(v.cumulative) > max ? BigInt(v.cumulative) : max),
        settled,
      );
      let dead = served.filter((row) => row.cumulative > reach).map((row) => row.intentId);
      if (dead.length === 0) continue;
      // A `NoBucket` recorded before the dispute check, while a dispute still
      // keeps a bucket on this lane, is the buyer's too (B-1).
      const reason =
        channel.lastSkipReason === 'NoBucket' && disputeKeeps(rows)
          ? NO_BUCKET_DISPUTE_KEPT
          : (channel.lastSkipReason ?? null);
      const cause = classifyLapse(reason);
      // A call that was already a buyer debt (renewed, dead again) stays debt
      // unless the provider caused it (B-2): a platform-class reason after the
      // renew does not erase what was owed.
      const wasDebt = new Set(served.filter((row) => row.everLapsed).map((row) => row.intentId));
      const redebt = cause === 'PLATFORM' ? dead.filter((id) => wasDebt.has(id)) : [];
      if (redebt.length > 0) {
        const lapsed = await this.channels.lapse(
          channel.id,
          redebt,
          `ChannelVoucherExpired:RELAPSE:${reason ?? 'unknown'}`,
        );
        if (lapsed > 0) {
          this.batch.add(
            AlertSeverity.WARN,
            'channel_calls_lapsed',
            `RELAPSE:${reason ?? 'unknown'}`,
            channel.channelKey,
            `Renewed channel debts could not be settled again (${reason ?? 'none'}): still buyer debt`,
          );
        }
        dead = dead.filter((id) => !wasDebt.has(id));
        if (dead.length === 0) continue;
      }
      if (cause === 'BUYER') {
        const lapsed = await this.channels.lapse(
          channel.id,
          dead,
          `ChannelVoucherExpired:${reason ?? 'unknown'}`,
        );
        if (lapsed > 0) {
          this.batch.add(
            AlertSeverity.WARN,
            'channel_calls_lapsed',
            reason ?? 'unknown',
            channel.channelKey,
            `Served channel calls can no longer be settled (${reason}, the buyer's side): buyer debt`,
          );
        }
        continue;
      }
      const mark =
        cause === 'PROVIDER'
          ? `${PROVIDER_FORFEIT_PREFIX}Channel${reason}`
          : `${DEBT_VOIDED_PREFIX}CHANNEL_${reason ?? 'UNSETTLED'}`;
      const closed = await this.closeAndRelease(channel.id, dead, mark);
      if (closed > 0) {
        this.batch.add(
          AlertSeverity.WARN,
          cause === 'PROVIDER' ? 'channel_calls_forfeited' : 'channel_calls_voided',
          reason ?? 'UNSETTLED',
          channel.channelKey,
          cause === 'PROVIDER'
            ? `Served channel calls could not be settled for a provider reason (${reason}): the ` +
                `provider forfeits them, the buyers' holds are released`
            : `Served channel calls could not be settled for a platform reason (${reason ?? 'none'}): ` +
                `voided, nobody charged, nobody credited`,
        );
      }
    }
  }

  /** Marks served unsettled calls closed (forfeit or void) and releases their buyer holds. */
  private async closeAndRelease(
    channelRowId: string,
    intentIds: readonly string[],
    mark: string,
  ): Promise<number> {
    const closed = await this.channels.closeUnsettled(channelRowId, intentIds, mark);
    for (const row of closed) await this.release(row.organizationId, row.intentId, row.holdId);
    return closed.length;
  }

  private async release(organizationId: string, intentId: string, holdId: string): Promise<void> {
    try {
      await this.intents.releaseHold({ organizationId, id: intentId, holdId });
    } catch (error) {
      this.logger.warn(`releasing the hold of ${intentId}: ${describe(error)}`);
    }
  }

  // ── 6–8. Round ───────────────────────────────────────────────────────────

  private async round(
    asset: AssetId,
    channels: readonly VoucherChannelEntity[],
    calls: ReadonlyMap<string, ChannelCallRecord[]>,
    chainNow: number,
    hold: number,
    rate: number,
    collectDeferred: ReadonlySet<string>,
  ): Promise<void> {
    const pending: ChannelPending[] = [];
    // Chain clock minus wall clock, in seconds (e2e R-2).
    const clockDrift = chainNow - Math.floor(this.now() / 1000);
    // One read per (payer, signer) and per provider this pass.
    const windowCache = new Map<string, Promise<SignerWindow | null>>();
    const windows = (channel: VoucherChannelEntity) => {
      const key = `${channel.payer}|${channel.signer}`.toLowerCase();
      if (!windowCache.has(key)) {
        windowCache.set(
          key,
          this.door
            .signerWindow(asset, addressOf(channel.payer), addressOf(channel.signer))
            .catch((error: unknown) => {
              this.logger.warn(`signer window of ${channel.signer}: ${describe(error)}`);
              return null;
            }),
        );
      }
      return windowCache.get(key)!;
    };
    const riskCache = new Map<string, Promise<boolean>>();
    const risky = (channel: VoucherChannelEntity) => {
      const key = channel.providerAccount.toLowerCase();
      if (!riskCache.has(key)) riskCache.set(key, this.providerAtRisk(asset, channel));
      return riskCache.get(key)!;
    };
    const vouchersOf = new Map<string, Awaited<ReturnType<VoucherChannelRepository['vouchers']>>>();
    for (const channel of channels) {
      if (channel.status === VoucherChannelStatus.DESYNC && channel.statusReason === 'RECONCILE')
        continue;
      const settled = BigInt(channel.settledCumulative);
      const rows = (calls.get(channel.id) ?? []).filter((row) => row.cumulative > settled);
      const served = rows.filter((row) => servedOpen(row));
      const blocked = this.blockedSide(channel);
      if (blocked) {
        await this.channels.setLastSkip(
          channel.id,
          blocked.side === 'PROVIDER' ? 'PROVIDER_BLOCKED' : 'PAYER_BLOCKED',
        );
        if (blocked.side === 'PROVIDER' && channel.settlingTo === null) {
          // As per call: a blocked provider forfeits what it served, at once.
          const forfeited = await this.closeAndRelease(
            channel.id,
            served.filter((row) => !row.settlementId).map((row) => row.intentId),
            `${PROVIDER_FORFEIT_PREFIX}${blocked.cause}`,
          );
          if (forfeited > 0) {
            this.batch.add(
              AlertSeverity.WARN,
              'channel_calls_forfeited',
              blocked.cause,
              channel.channelKey,
              `A blocked provider's unsettled channel calls are forfeited; buyers' holds released`,
            );
          }
        }
        continue;
      }
      const amount = served
        .filter((row) => chargeable(row))
        .reduce((sum, row) => sum + row.price, 0n);
      if (served.length === 0 && channel.lastSkipReason && channel.settlingTo === null) {
        // Nothing left to settle: the reason a past settle did not land must
        // not classify a later lapse of new calls (final review MF-5).
        await this.channels.setLastSkip(channel.id, null);
      }
      const vouchers = await this.channels.vouchers(channel.id, settled);
      vouchersOf.set(channel.id, vouchers);
      // The signer's on-chain window, read only for a channel with value to settle.
      const window = amount > 0n ? await windows(channel) : null;
      const deadline = channelDeadline({
        newestUsableExpiresAt: newestUsableExpiry(settled, vouchers.map(toStored), chainNow),
        signerValidUntil:
          window?.validUntil ??
          (channel.signerValidUntil ? Number(channel.signerValidUntil) : null),
        revokeGraceEndsAt: window?.revokeGraceEndsAt ?? null,
        heldCapsEndAt: window?.heldCapsEndAt ?? null,
      });
      if (deadline !== null && (channel.deadlineAt?.getTime() ?? 0) !== deadline * 1000) {
        await this.channels.setDeadline(channel.id, new Date(deadline * 1000));
      } else if (amount === 0n && channel.deadlineAt && channel.settlingTo === null) {
        // Nothing left to settle: a stale deadline must not rank this lane
        // ahead of lanes that have one (MF-3).
        await this.channels.setDeadline(channel.id, null);
      }
      const chargedRows = served.filter((row) => chargeable(row));
      // `created_at` is the wall clock; the round compares ages with the chain
      // clock. Moved onto the chain clock by the current drift, so the age is
      // the wall-clock age whatever the drift (e2e R-2).
      const oldest = chargedRows.length
        ? Math.floor(Math.min(...chargedRows.map((row) => row.createdAt.getTime())) / 1000) +
          clockDrift
        : null;
      pending.push({
        channelRowId: channel.id,
        payer: channel.payer,
        provider: channel.providerAccount,
        pendingAtomic: amount,
        oldestUnsettledAt: oldest,
        deadline,
        settling: channel.settlingTo !== null,
        providerRisk: amount > 0n ? await risky(channel) : false,
      });
      this.alertAge(channel, oldest, deadline, chainNow);
    }

    const urgent = this.urgentChannels(channels, pending);
    // Drain on ANY take-rate change, both directions (SPEC-W2 §3): the rate in
    // force at settlement applies, so pending value settles now rather than
    // wait across a second change. The runbook drains BEFORE a change; this
    // catches one made without it.
    // After a restart the in-memory rate is gone: the rate the newest landed
    // settlement of this asset was charged at stands in (final review MF-9),
    // so a change made while the scheduler was down still drains.
    const seen = this.lastRate.has(asset) ? this.lastRate.get(asset) : await this.landedRate(asset);
    this.lastRate.set(asset, rate);
    if (seen !== undefined && seen !== rate) {
      this.logger.warn(`take rate on ${asset} changed ${seen} → ${rate}: draining every channel`);
      for (const p of pending) if (p.pendingAtomic > 0n) urgent.add(p.channelRowId);
    }
    const decision = decideRound(pending, chainNow, this.policy, urgent);
    if (!decision.fire) return;
    await this.channels.clearUrgent([...urgent]);

    const planned: Planned[] = [];
    for (const channelRowId of decision.members) {
      const channel = channels.find((c) => c.id === channelRowId)!;
      const trigger = decision.triggers.get(channel.id) ?? 'PIGGYBACK';
      // Its collect was put off: no settle that could fold its payout later,
      // unless the deadline forces it (review 2026-10-31 M5).
      if (collectDeferred.has(channel.id) && trigger !== 'DEADLINE') continue;
      const plan = await this.plan(
        asset,
        channel,
        calls.get(channel.id) ?? [],
        vouchersOf.get(channel.id) ?? [],
        chainNow,
        hold,
        rate,
        trigger,
      );
      if (plan) planned.push(plan);
    }
    if (planned.length === 0) return;

    // Deadline items first, on their own lane, taken round-robin across
    // providers (sec-audit B-3): one provider's many lanes cannot fill the
    // first batches of the deadline lane ahead of everyone else. Then the
    // rest by deadline.
    const deadlineFirst = fairDeadlineOrder(planned);
    const groups: { lane: SendLane; items: Planned[] }[] = [];
    for (const plan of deadlineFirst) {
      const lane: SendLane = laneOfTrigger(plan.trigger);
      let group = groups[groups.length - 1];
      const laneOf = (l: SendLane) => (l === 'DEADLINE' ? 'DEADLINE' : 'OTHER');
      if (
        !group ||
        laneOf(group.lane) !== laneOf(lane) ||
        group.items.length >= CHANNEL_MAX_BATCH
      ) {
        group = { lane, items: [] };
        groups.push(group);
      }
      // A non-deadline group goes on the most urgent lane any of its items needs.
      if (group.lane === 'ORDINARY' && lane === 'URGENT') group.lane = 'URGENT';
      group.items.push(plan);
    }
    for (const group of groups) await this.sendGroup(asset, group.items, group.lane);
  }

  /** One channel's settle item, bound to its rows, or `null` (nothing to settle, or it cannot). */
  private async plan(
    asset: AssetId,
    channel: VoucherChannelEntity,
    rows: readonly ChannelCallRecord[],
    vouchers: Awaited<ReturnType<VoucherChannelRepository['vouchers']>>,
    chainNow: number,
    hold: number,
    rate: number,
    trigger: RoundTrigger | 'PIGGYBACK',
  ): Promise<Planned | null> {
    const settled = BigInt(channel.settledCumulative);
    const callRows: ChannelCallRow[] = rows
      .filter((row) => row.cumulative > settled)
      .map((row) => ({
        intentId: row.intentId,
        cumulative: row.cumulative,
        price: row.price,
        terminal: CHANNEL_TERMINAL_STATUSES.includes(row.status),
        // Charged into hold: served, hold open, not lapsed nor closed; a
        // pre-settlement dispute is charged and KEPT (SPEC-W2 §5), unless
        // upheld before now.
        charged: chargeable(row),
      }));
    const choice = chooseSettlement(
      settled,
      vouchers.map(toStored),
      callRows,
      chainNow,
      this.policy,
    );
    if (!choice) return null;
    const books = await this.door.readBooks(asset, channel.channelKey as `0x${string}`);
    if (!books) return null;
    if (books.slot.settled !== settled) return null; // recovered next pass, or the reconciler's case
    if (placeCharge(books.slot, chainNow, hold, rate, choice.charge) === 'NO_BUCKET') {
      // Collect-first ran; a bucket still cannot be found (a dispute keeps a
      // matured bucket, or a rate change): this lane is retired (v3 §5.5).
      // Which one is recorded precisely: a dispute keep is the buyer's side
      // (its lapse is debt, B-1), anything else stays the platform's.
      const reason = disputeKeeps(rows) ? NO_BUCKET_DISPUTE_KEPT : 'NoBucket';
      await this.channels.setStatus(channel.id, VoucherChannelStatus.ROTATED, 'NO_BUCKET');
      await this.channels.setLastSkip(channel.id, reason);
      this.batch.add(
        AlertSeverity.WARN,
        'channel_no_bucket',
        reason,
        channel.channelKey,
        `A channel has no free bucket; ROTATED (clients open a new lane)`,
      );
      return null;
    }
    const voucher = vouchers.find((v) => v.id === choice.voucher.id)!;
    const previousCalls = channel.settledCalls;
    const settlementId = await this.channels.bindSettlement({
      channelRowId: channel.id,
      voucherId: voucher.id,
      fromSettled: choice.fromSettled,
      toCumulative: choice.voucher.cumulative,
      fromCalls: previousCalls,
      toCalls: choice.voucher.calls,
      charge: choice.charge,
      waived: choice.waived,
      trigger,
      intentIds: choice.rows.map((row) => row.intentId),
      chargedIntentIds: choice.rows.filter((row) => row.charged).map((row) => row.intentId),
    });
    if (!settlementId) return null;
    const message: ChannelVoucherMessage = {
      payer: addressOf(channel.payer),
      provider: addressOf(channel.providerAccount),
      channelId: channel.channelId as `0x${string}`,
      cumulative: BigInt(voucher.cumulative),
      calls: voucher.calls,
      issuedAt: BigInt(voucher.issuedAt),
      expiresAt: BigInt(voucher.expiresAt),
    };
    return {
      channel,
      choice,
      settlementId,
      item: {
        voucher: message,
        signature: voucher.signature as `0x${string}`,
        fromSettled: choice.fromSettled,
        charge: choice.charge,
      },
      trigger,
      deadline: channel.deadlineAt ? Math.floor(channel.deadlineAt.getTime() / 1000) : null,
    };
  }

  /**
   * Simulates, sends and books one group. Released only when the chain did
   * not change: a deferral or refusal before the broadcast, a revert, an item
   * the simulation or the receipt skips. An error after a possible broadcast
   * (a receipt timeout, a dropped connection, a crash while booking) leaves
   * the settlements SENT with their recorded hash: the next pass reads them
   * back (`landInFlight`), and nothing is sent for them meanwhile.
   */
  private async sendGroup(asset: AssetId, plans: Planned[], lane: SendLane): Promise<void> {
    let live = plans;
    let broadcastStarted = false;
    try {
      const simulated = await this.door.simulateSettle(
        asset,
        live.map((p) => p.item),
      );
      const keep: Planned[] = [];
      for (let i = 0; i < live.length; i += 1) {
        const outcome = simulated[i];
        if (outcome?.kind === 'SKIPPED') {
          await this.channels.releaseSettlement(
            live[i].settlementId,
            ChannelSettlementStatus.DROPPED,
            `sim:${outcome.reason}`,
          );
          await this.skipped(
            asset,
            live[i].channel,
            outcome.reason,
            live[i].settlementId,
            `${live[i].choice.fromSettled}→${live[i].choice.voucher.cumulative}`,
          );
        } else {
          keep.push(live[i]);
        }
      }
      live = keep;
      if (live.length === 0) return;
      for (const plan of live) await this.channels.markSent(plan.settlementId, null);
      broadcastStarted = true;
      const result = await this.door.settle(
        asset,
        live.map((p) => p.item),
        lane,
        {
          // Recorded on every settlement of the group BEFORE the broadcast.
          beforeBroadcast: async (hash, signed) => {
            await recordSigned(this.channels, hash, signed);
            for (const plan of live) await this.channels.markSent(plan.settlementId, hash);
          },
        },
      );
      this.pausedSince.delete(asset);
      for (let i = 0; i < live.length; i += 1) {
        const outcome = result.outcomes[i];
        if (!outcome) continue;
        if (outcome.kind === 'SKIPPED') {
          await this.channels.releaseSettlement(
            live[i].settlementId,
            ChannelSettlementStatus.SKIPPED,
            outcome.reason,
          );
          await this.skipped(
            asset,
            live[i].channel,
            outcome.reason,
            live[i].settlementId,
            `${live[i].choice.fromSettled}→${live[i].choice.voucher.cumulative}`,
          );
          continue;
        }
        await this.book(
          live[i].channel,
          live[i].settlementId,
          outcome,
          result.txRef,
          result.landedAt,
        );
      }
    } catch (error) {
      if (!broadcastStarted || channelSendNotSent(error)) {
        // The chain did not change: unbind, retry next tick.
        for (const plan of live) {
          await this.channels
            .releaseSettlement(plan.settlementId, ChannelSettlementStatus.DROPPED, 'send failed')
            .catch(() => undefined);
          await this.channels
            .setLastSkip(
              plan.channel.id,
              error instanceof ChannelSendDeferredError ? 'DEFERRED' : 'SEND_FAILED',
            )
            .catch(() => undefined);
        }
        await this.sendFailed(asset, 'settleChannels', error);
        return;
      }
      // Possibly broadcast: kept SENT for the read-back.
      for (const plan of live) {
        this.batch.add(
          AlertSeverity.WARN,
          'channel_settle_outcome_unknown',
          'UNKNOWN',
          plan.channel.channelKey,
          `A channel settle's outcome is unknown (${oneLine(describe(error))}); it is read ` +
            `back from the chain, never re-sent blindly`,
        );
      }
    }
  }

  /**
   * Books one landed settle item: the channel's settled pair, exactly the
   * calls bound as charged at plan time into the hold, the rest waived
   * (review 2026-10-31 H2/L1). Only when the outcome is this settlement's own
   * — the channel's key, its target cumulative (L2); otherwise nothing is
   * booked and the read-back decides from chain state.
   */
  private async book(
    channel: VoucherChannelEntity,
    settlementId: string,
    outcome: Extract<SettleItemOutcome, { kind: 'SETTLED' }>,
    txRef: string,
    landedAt: number,
  ): Promise<void> {
    const settlement = await this.channels.findSettlement(settlementId);
    if (!settlement) return;
    const keyMatches =
      !outcome.key ||
      outcome.key === '0x' ||
      outcome.key.toLowerCase() === channel.channelKey.toLowerCase();
    if (!keyMatches || outcome.cumulative !== BigInt(settlement.toCumulative)) {
      await this.alert(
        AlertSeverity.CRITICAL,
        'channel_settle_outcome_mismatch',
        `Channel ${channel.channelKey}: a settle outcome (${outcome.key} at ${outcome.cumulative}) does ` +
          `not match its settlement (to ${settlement.toCumulative}); not booked, read back from the chain.`,
        { key: channel.channelKey, settlementId, txRef },
        settlementId,
      );
      return;
    }
    const bound = (await this.channels.calls(channel.id, BigInt(settlement.fromSettled))).filter(
      (row) => row.settlementId === settlementId,
    );
    const chargedIds = new Set(settlement.chargedIntentIds ?? []);
    const charged = bound.filter((row) => chargedIds.has(row.intentId));
    const waived = bound.filter((row) => !chargedIds.has(row.intentId));
    const chargedSum = charged.reduce((sum, row) => sum + row.price, 0n);
    if (chargedSum !== outcome.charge) {
      this.batch.add(
        AlertSeverity.CRITICAL,
        'channel_settle_charge_mismatch',
        'CHARGE',
        channel.channelKey,
        `A channel settle charged a different sum than its bound calls (tx ${txRef})`,
      );
    }
    const collectableAt = new Date(outcome.maturityHour * CHANNEL_GRID_SECONDS * 1000);
    let unbooked = 0;
    await this.channels.manager.transaction(async (manager) => {
      const landed = await this.channels.landSettlement(manager, settlementId, channel.id, {
        cumulative: outcome.cumulative,
        calls: outcome.calls,
        maturityHour: outcome.maturityHour,
        takeRateBps: outcome.takeRateBps,
        txRef,
      });
      if (!landed) return;
      if (outcome.deferred) {
        await this.channels.deferBucket(
          manager,
          channel.id,
          outcome.deferred.fromHour,
          outcome.deferred.toHour,
          outcome.takeRateBps,
        );
      }
      const booked = await this.channels.bookCharged(
        manager,
        channel.id,
        charged.map((r) => r.intentId),
        new Date(landedAt * 1000),
        collectableAt,
        outcome.takeRateBps,
      );
      unbooked = charged.length - booked;
      await this.channels.markWaived(
        manager,
        channel.id,
        waived.map((r) => r.intentId),
        'NOT_CHARGED',
      );
    });
    if (unbooked > 0) {
      // The chain charged a call this database can no longer hold (its buyer
      // hold closed meanwhile). Never released silently: paged.
      this.batch.add(
        AlertSeverity.CRITICAL,
        'channel_settle_unbookable',
        'HOLD_CLOSED',
        channel.channelKey,
        `A channel settle charged calls whose buyer hold had closed; booked none of them (tx ${txRef})`,
      );
    }
    // A served call NOT charged (a dispute upheld before the bind): its buyer
    // hold goes back now. A later uphold of a CHARGED call is refunded on
    // chain (`refundHeldForDispute`), never released here.
    for (const row of waived) {
      if (
        row.holdOpen &&
        row.status === 'SETTLED' &&
        !row.lapsed &&
        !row.closed &&
        !row.heldStatus
      ) {
        const holdId =
          row.holdId ?? (await this.intents.findById(row.organizationId, row.intentId))?.holdId;
        if (holdId) await this.release(row.organizationId, row.intentId, holdId);
      }
    }
    await this.channels.refreshOldestUnsettled(channel.id);
    // Money kept for a dispute in a bucket: the lane takes no new voucher (v3 §5.5).
    if (charged.some((row) => row.disputeOutcome === 'OPEN')) {
      await this.channels.setStatus(channel.id, VoucherChannelStatus.ROTATED, 'DISPUTE_KEPT');
    }
  }

  /**
   * A settle the chain (or its simulation) skipped: the reason is recorded
   * for the lapse classification, `Blocked` split by side; Authority →
   * REVOKED, NoBucket → ROTATED; the paged reasons are aggregated.
   */
  private async skipped(
    asset: AssetId,
    channel: VoucherChannelEntity,
    reason: string,
    settlementId: string,
    step: string,
  ): Promise<void> {
    let recorded = reason;
    if (reason === 'NoBucket') {
      // As in `plan` (B-1): a dispute keep on this lane makes it the buyer's.
      try {
        if (disputeKeeps(await this.channels.calls(channel.id))) recorded = NO_BUCKET_DISPUTE_KEPT;
      } catch (error) {
        this.logger.warn(`dispute keep of ${channel.channelKey}: ${describe(error)}`);
      }
    }
    if (reason === 'Authority') recorded = await this.authorityCause(asset, channel);
    if (reason === 'Blocked') {
      const providerBlocked = await this.door
        .providerRisk(asset, addressOf(channel.providerAccount))
        .then((risk) => risk.blocked)
        .catch(() => false);
      recorded = providerBlocked ? 'Blocked:PROVIDER' : 'Blocked:PAYER';
    }
    await this.channels.setLastSkip(channel.id, recorded);
    if (reason === 'Authority') {
      await this.channels.setStatus(channel.id, VoucherChannelStatus.REVOKED, 'AUTHORITY');
    } else if (reason === 'NoBucket') {
      await this.channels.setStatus(channel.id, VoucherChannelStatus.ROTATED, 'NO_BUCKET');
    }
    if (PAGED_SKIPS.has(reason) || reason.endsWith('Window')) {
      this.batch.add(
        reason === 'BaseMismatch' || reason === 'Expired' || reason === 'BadSignature'
          ? AlertSeverity.CRITICAL
          : AlertSeverity.WARN,
        'channel_settle_skipped',
        reason,
        channel.channelKey,
        `Channel settles skipped on ${asset} (${reason}); e.g. step ${step}, settlement ${settlementId}`,
      );
    }
  }

  /** The rate of the newest landed settlement on `asset` (MF-9), or `undefined`. */
  private async landedRate(asset: AssetId): Promise<number | undefined> {
    try {
      return (await this.channels.lastLandedRate(asset)) ?? undefined;
    } catch (error) {
      this.logger.warn(`last landed rate on ${asset}: ${describe(error)}`);
      return undefined;
    }
  }

  /**
   * Who an `Authority` skip is on (final review MF-4). The settle deadline
   * already includes the delegate's `validUntil`, so a delegate that simply
   * reached the `validUntil` admission saw — not revoked, not shortened —
   * means the platform did not settle in time (an outage, a dry float): the
   * platform's ({@link AUTHORITY_LAPSED}, voided), as on a payer-signed lane.
   * A revoked delegate, a `validUntil` moved earlier than admission saw, or a
   * window that cannot be read stays `Authority` (the buyer's).
   */
  private async authorityCause(asset: AssetId, channel: VoucherChannelEntity): Promise<string> {
    if (channel.signer.toLowerCase() === channel.payer.toLowerCase()) return 'Authority';
    try {
      const [window, now] = await Promise.all([
        this.door.signerWindow(asset, addressOf(channel.payer), addressOf(channel.signer)),
        this.door.chainNow(asset),
      ]);
      if (!window || window.revoked || window.validUntil === null) return 'Authority';
      const admitted = channel.signerValidUntil ? Number(channel.signerValidUntil) : null;
      const shortened = admitted !== null && window.validUntil < admitted;
      return window.validUntil <= now && !shortened ? AUTHORITY_LAPSED : 'Authority';
    } catch (error) {
      this.logger.warn(`authority cause of ${channel.channelKey}: ${describe(error)}`);
      return 'Authority';
    }
  }

  /**
   * Provider risk (v3 §5.4.3): unbonding requested, a slash pending (on chain,
   * or held by this platform's own case), free stake near the minimum (a raised
   * minimum), or the provider blocked. Its channels settle now, on the URGENT
   * lane, while the charge still passes the stake and blocklist gates.
   * Debounced by the round itself: once settled there is nothing pending.
   */
  private async providerAtRisk(asset: AssetId, channel: VoucherChannelEntity): Promise<boolean> {
    if (channel.urgentReason === 'SLASH') return true;
    try {
      if (await this.slashHolds?.isHeld(channel.providerId, channel.chainId)) return true;
      const risk = await this.door.providerRisk(asset, addressOf(channel.providerAccount));
      return risk.unbonding || risk.slashPending || risk.nearFloor || risk.blocked;
    } catch (error) {
      this.logger.warn(`provider risk of ${channel.providerAccount}: ${describe(error)}`);
      return false;
    }
  }

  /** Channels an urgent request covers, at most one urgent round per payer per interval. */
  private urgentChannels(
    channels: readonly VoucherChannelEntity[],
    pending: readonly ChannelPending[],
  ): Set<string> {
    const now = this.now();
    const out = new Set<string>();
    for (const channel of channels) {
      if (!channel.urgentRequestedAt) continue;
      if (!pending.some((p) => p.channelRowId === channel.id && p.pendingAtomic > 0n)) continue;
      // An operator drain and a pending slash are never rate-limited.
      if (channel.urgentReason === 'DRAIN' || channel.urgentReason === 'SLASH') {
        out.add(channel.id);
        continue;
      }
      const key = channel.payer.toLowerCase();
      const last = this.urgentAt.get(key);
      if (last !== undefined && now - last < this.policy.urgentIntervalSeconds * 1000) continue;
      out.add(channel.id);
    }
    for (const id of out) {
      const channel = channels.find((c) => c.id === id)!;
      if (channel.urgentReason === 'DRAIN' || channel.urgentReason === 'SLASH') continue;
      this.urgentAt.set(channel.payer.toLowerCase(), now);
    }
    return out;
  }

  // ── Unpaid claims (override M-3) ─────────────────────────────────────────

  /**
   * Pays the unpaid payouts an operator asked to claim (`claimUnpaid`,
   * permissionless on chain, idempotent: a claim pays what `unpaid[to]` holds
   * now). An address the chain shows nothing unpaid for (claimed meanwhile)
   * is marked claimed without a send.
   */
  private async claims(asset: AssetId): Promise<void> {
    let addresses: string[];
    try {
      addresses = await this.channels.claimRequests(asset);
    } catch {
      return;
    }
    for (const address of addresses) {
      try {
        const books = await this.door.readBooks(
          asset,
          `0x${'0'.repeat(64)}`,
          address as `0x${string}`,
        );
        if (!books) continue;
        if (books.unpaid === 0n) {
          await this.channels.markClaimed(asset, address, null);
          continue;
        }
        const sent = await this.door.claimUnpaid(asset, checksumAddress(address));
        await this.channels.markClaimed(asset, address, sent.txRef);
        await this.alert(
          AlertSeverity.WARN,
          'channel_unpaid_claimed',
          `Unpaid payouts of ${address} on ${asset} (${books.unpaid}) were claimed (${sent.txRef}).`,
          { asset, address, txRef: sent.txRef },
          `${asset}:${address}:claimed`,
        );
      } catch (error) {
        // Retried next pass: a claim pays only what is still unpaid.
        await this.sendFailed(asset, 'claimUnpaid', error);
      }
    }
  }

  // ── Alerts ───────────────────────────────────────────────────────────────

  private alertAge(
    channel: VoucherChannelEntity,
    oldest: number | null,
    deadline: number | null,
    chainNow: number,
  ): void {
    if (!this.policy.switches.perChannelAlerts) return;
    if (deadline !== null && oldest !== null && deadline - chainNow < DEADLINE_CRITICAL_SECONDS) {
      this.batch.add(
        AlertSeverity.CRITICAL,
        'channel_deadline_near',
        'DEADLINE',
        channel.channelKey,
        `Unsettled channel value is less than 45 min from its deadline`,
      );
    } else if (oldest !== null && chainNow - oldest > UNSETTLED_WARN_SECONDS) {
      this.batch.add(
        AlertSeverity.WARN,
        'channel_unsettled_old',
        'AGE',
        channel.channelKey,
        `A channel's oldest unsettled call is over 70 min old`,
      );
    }
  }

  /** One alert per (name, reason) of this pass, with the channel count (M6). */
  private async flush(asset: AssetId): Promise<void> {
    for (const entry of this.batch.drain()) {
      const count = entry.keys.length;
      await this.alert(
        entry.severity,
        entry.name,
        `${entry.summary} — ${count} channel(s) on ${asset}` +
          (count > 0 ? `, e.g. ${entry.keys.slice(0, 3).join(', ')}` : ''),
        { asset, reason: entry.reason, count, keys: entry.keys.slice(0, 10) },
        `${asset}:${entry.name}:${entry.reason}`,
      );
    }
  }

  private async sendFailed(asset: AssetId, what: string, error: unknown): Promise<void> {
    const message = oneLine(describe(error));
    if (/ProgramPaused/.test(message)) {
      const since = this.pausedSince.get(asset) ?? this.now();
      this.pausedSince.set(asset, since);
      if (this.now() - since > PAUSE_ALERT_SECONDS * 1000) {
        await this.alert(
          AlertSeverity.CRITICAL,
          'channel_program_paused',
          `The escrow on ${asset} has been paused for over an hour: channels are not settling.`,
          { asset },
          `${asset}:paused`,
        );
      }
      return;
    }
    // A revert (simulated before the send, or mined) is never a mere deferral
    // (ops F9): a named one is reported, an unknown one is paged CRITICAL.
    if (/\b(would revert|reverted)\b/.test(message)) {
      const unknown = /UNKNOWN_REVERT|reverted: unknown|would revert$/.test(message);
      await this.alert(
        unknown ? AlertSeverity.CRITICAL : AlertSeverity.WARN,
        unknown ? 'channel_send_unknown_revert' : 'channel_send_reverted',
        `${what} on ${asset} reverts: ${message}`,
        { asset, what },
        `${asset}:${what}:revert`,
      );
      return;
    }
    if (error instanceof ChannelSendDeferredError) {
      this.logger.warn(`${what} on ${asset} deferred: ${error.detail}`);
      return;
    }
    await this.alert(
      AlertSeverity.WARN,
      'channel_send_failed',
      `${what} on ${asset} failed: ${message}`,
      { asset, what },
      `${asset}:${what}`,
    );
  }

  private async alert(
    severity: AlertSeverity,
    name: string,
    summary: string,
    details: Record<string, unknown>,
    dedupeKey: string,
  ): Promise<void> {
    try {
      await this.alerts.emit({
        severity,
        name,
        summary,
        details: Object.fromEntries(
          Object.entries(details).map(([k, v]) => [
            k,
            typeof v === 'number' ? v : Array.isArray(v) ? v.join(',') : String(v),
          ]),
        ),
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey,
      });
    } catch (error) {
      this.logger.warn(`alert ${name} not sent: ${describe(error)}`);
    }
  }
}

/** A served call whose buyer hold is open, not in a bucket, not lapsed, not closed. */
function servedOpen(row: ChannelCallRecord): boolean {
  return row.status === 'SETTLED' && row.holdOpen && !row.heldStatus && !row.lapsed && !row.closed;
}

/**
 * Deadline items first, round-robin across providers (each provider's own in
 * deadline order; providers by their earliest deadline), then every other
 * item by deadline (sec-audit 2026-11-01 B-3).
 */
export function fairDeadlineOrder<
  T extends {
    readonly trigger: string;
    readonly deadline: number | null;
    readonly channel: { readonly providerAccount: string };
  },
>(planned: readonly T[]): T[] {
  const byDeadline = (a: T, b: T) =>
    (a.deadline ?? Number.MAX_SAFE_INTEGER) - (b.deadline ?? Number.MAX_SAFE_INTEGER);
  const queues = new Map<string, T[]>();
  for (const plan of [...planned].filter((p) => p.trigger === 'DEADLINE').sort(byDeadline)) {
    const provider = plan.channel.providerAccount.toLowerCase();
    queues.set(provider, [...(queues.get(provider) ?? []), plan]);
  }
  const fair: T[] = [];
  const order = [...queues.values()];
  while (order.some((queue) => queue.length > 0)) {
    for (const queue of order) {
      const next = queue.shift();
      if (next) fair.push(next);
    }
  }
  return [...fair, ...planned.filter((p) => p.trigger !== 'DEADLINE').sort(byDeadline)];
}

/**
 * A dispute keeps money in a bucket of this lane: a HELD call whose dispute
 * is open or upheld (not refunded yet), the rows collect-first keeps (B-1).
 */
function disputeKeeps(rows: readonly ChannelCallRecord[]): boolean {
  return rows.some(
    (row) =>
      row.heldStatus === 'HELD' &&
      (row.disputeOutcome === 'OPEN' || row.disputeOutcome === 'UPHELD'),
  );
}

/** What a settle charges into the hold: served and open, unless a dispute was upheld first. */
function chargeable(row: ChannelCallRecord): boolean {
  return servedOpen(row) && row.disputeOutcome !== 'UPHELD';
}

/** The channel's newest bucket (a charge always lands in the newest). */
function newestBucket(slot: ChannelSlot): { m: number; r: number } {
  return slot.h2 > 0n && slot.m2 >= slot.m1
    ? { m: slot.m2, r: slot.r2 }
    : { m: slot.m1, r: slot.r1 };
}

/** A landed settlement booked from chain state when no receipt has it. */
function fromBooks(
  channel: VoucherChannelEntity,
  settlement: ChannelSettlementEntity,
  slot: ChannelSlot,
): Extract<SettleItemOutcome, { kind: 'SETTLED' }> {
  const newest = newestBucket(slot);
  return {
    kind: 'SETTLED',
    index: 0,
    key: channel.channelKey as `0x${string}`,
    cumulative: BigInt(settlement.toCumulative),
    calls: settlement.toCalls,
    charge: BigInt(settlement.charge),
    maturityHour: newest.m,
    takeRateBps: newest.r,
    opened: null,
    deferred: null,
  };
}

function toStored(v: {
  id: string;
  cumulative: string;
  calls: number;
  issuedAt: string;
  expiresAt: string;
}) {
  return {
    id: v.id,
    cumulative: BigInt(v.cumulative),
    calls: v.calls,
    issuedAt: Number(v.issuedAt),
    expiresAt: Number(v.expiresAt),
  };
}

function addressOf(account: string): `0x${string}` {
  return checksumAddress(parseAccountId(account as never).address);
}

function refOf(channel: VoucherChannelEntity): ChannelRefInput {
  return {
    payer: addressOf(channel.payer),
    signer: addressOf(channel.signer),
    provider: addressOf(channel.providerAccount),
    channelId: channel.channelId as `0x${string}`,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One line of an error for an alert (E-1): viem's messages carry the request
 * body, docs links and version on later lines.
 */
function oneLine(message: string): string {
  const first = message.split('\n').find((line) => line.trim() !== '') ?? message;
  const line = first.replace(/\s+/g, ' ').trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}
