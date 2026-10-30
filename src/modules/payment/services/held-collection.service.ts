import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import {
  PaymentIntentRepository,
  RedemptionExclusions,
} from '@database/postgres/repositories/payment-intent.repository';
import { BlockedRole, BlockSubjectKind, subjectKey } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { CHAIN_STATE_GATE, ChainStateGatePort } from '@modules/chains/ports/chain-state-gate.port';
import { AccountId, AssetId, ChainId, chainIdOf } from '@modules/chains/ports/caip.types';
import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
} from '@modules/notification/ports/notification.port';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import {
  HELD_PAYMENTS,
  HELD_TIMEOUT_SECONDS,
  HeldKey,
  HeldPaymentsPort,
  HeldStatus,
  MAX_HELD_BATCH,
} from '../ports/held-payments.port';
import { PaymentRail } from '../ports/payment.types';
import { EVM_FEE_CAP_WAIVED_WITHIN_SECONDS } from '@modules/chains/evm/evm-l1-gas';
import {
  COLLECT_GATHERING,
  COLLECT_GATHERING_FROM_ENV,
  GatheringPolicy,
  gatheringReady,
} from '../constants/settlement-gathering.constants';
import { PaymentIntentService } from './payment-intent.service';

/** Rail-A held credits booked per pass. */
const RAIL_A_BATCH = 500;
/** Single sends allowed per pass when a batch is refused (the shared redeemer queue). */
const MAX_SINGLES_PER_PASS = 8;
/** Past-timeout collects per asset per pass: one transaction each. */
const MAX_TIMEOUT_SINGLES_PER_PASS = 8;
/** `refundHeldBatch` transactions per asset per pass for blocked providers. */
const MAX_REFUND_BATCHES_PER_ASSET = 4;

/**
 * How long before the chain's timeout a record is already treated as past it:
 * sent singly, never in a batch. A batch sent just before the timeout and
 * mined after it races a stranger's `collectHeld` the same way, so the rule
 * starts this much early.
 */
export const TIMEOUT_RACE_MARGIN_SECONDS = 15 * 60;
/** A blocked provider's held payment still unrefunded this close to the timeout is paged. */
export const BLOCKED_REFUND_WARN_SECONDS = 24 * 3600;
/** …and for this long after it (then the record is only synced), once per window. */
export const BLOCKED_PAGE_PAST_SECONDS = 24 * 3600;

export const HELD_PAST_TIMEOUT_ALERT = 'held_payment_past_timeout';
export const BLOCKED_HELD_UNREFUNDED_ALERT = 'held_payment_blocked_provider_unrefunded';

/** The cause booked for a refund nothing else explains: only the redeemer can refund. */
export const REFUNDED_BY_REDEEMER_CAUSE = 'RefundedByRedeemer';
/** Longest first: a recorded cause is matched by prefix (it may carry a suffix). */
const PROVIDER_BLOCK_CAUSES: readonly string[] = [
  'PayeeBlockedOnChain',
  'ProviderBlocked',
  'PayeeBlocked',
];

type HeldMove = 'collect' | 'refund';

/** One pass: the provider-side blocks it read at its start, and what it refunded. */
interface Pass {
  /** For the queries: organizations, wallet keys and on-chain accounts of every held chain. */
  readonly exclude: RedemptionExclusions;
  /** CAIP-10 accounts the on-chain blocklists refuse, lower-case. */
  readonly chainAccounts: ReadonlySet<string>;
  /** Intents whose refund landed or was booked this pass: not paged on a lagging read. */
  readonly refunded: Set<string>;
  /** The cause recorded on an intent just before its refund was sent. */
  readonly causes: Map<string, string>;
}

/**
 * Collects held payments once their dispute window has passed (G3.B1, "redeem
 * into hold"): rail B with `collectHeldBatch` — the REDEEMER, so only in the
 * scheduler — rail A by crediting the provider in the ledger. Never one an
 * open or upheld dispute holds, and never one with a blocked party.
 *
 * The redeemer key is shared with the redemption job (which runs at second 0;
 * this one at second 30): one batch per asset per pass, at most
 * {@link MAX_SINGLES_PER_PASS} single sends when a batch is refused, every send
 * simulated first and given up rather than queued long (`boundQueueWait`).
 * A row that fails backs off (1, 2, 4 … minutes, at most an hour), so a stuck
 * row neither blocks the pass nor burns gas every minute.
 *
 * The provider is credited only once the chain says `COLLECTED`
 * (`PaymentIntentService.bookHeldCollected`), and every booking is idempotent.
 * Past the chain's timeout a disputed payment is never collected here (an
 * upheld refund may still be pending): its record is only read, booked once
 * someone collects it, and paged.
 *
 * ## Past the timeout: one by one
 *
 * From `collectableAt + HELD_TIMEOUT_SECONDS` anyone may collect a record, so
 * a stranger can collect one of a batch first and revert the whole atomic
 * batch. Such records (from {@link TIMEOUT_RACE_MARGIN_SECONDS} before) have
 * their own queue (`findTimedOutCollectable`) and are sent singly, never
 * batched; a single collect that fails is answered by reading `held()` — a
 * record already `COLLECTED` or `REFUNDED` is booked, not retried. Records
 * past the timeout that are never sent (disputed, or a blocked provider's) are
 * only synced, and backed off after each read, so they never starve the rest.
 *
 * ## A blocked provider: refunded at once, never collected
 *
 * When the platform blocks a provider — an operator's account block (`A-9`) on
 * its organization or its payout wallet, or the payout address on the chain's
 * own blocklist — every payment of it still held is refunded to the buyer on
 * the next pass: rail B with `refundHeldBatch` (chunked), rail A by releasing
 * the withheld credit; the provider forfeits, as at redemption. None is ever
 * collected for it: the block is checked again just before every send. One
 * still unrefunded within {@link BLOCKED_REFUND_WARN_SECONDS} of the timeout is
 * paged: after it the refund is closed for good.
 *
 * Only the redeemer can refund, so a chain `REFUNDED` is always this backend's
 * doing: unless an upheld dispute explains it, it is booked as the provider's
 * forfeit — under the cause recorded before the send, or
 * {@link REFUNDED_BY_REDEEMER_CAUSE} — even if the block was lifted meanwhile.
 */
@Injectable()
export class HeldCollectionService {
  private readonly logger = new Logger(HeldCollectionService.name);

  constructor(
    private readonly payments: PaymentIntentRepository,
    private readonly intents: PaymentIntentService,
    private readonly blocklist: AccountBlocklistService,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Optional() @Inject(HELD_PAYMENTS) private readonly held: HeldPaymentsPort | null = null,
    @Optional()
    @Inject(CHAIN_STATE_GATE)
    private readonly chainState: ChainStateGatePort | null = null,
    @Optional()
    @Inject(NOTIFICATION_PORT)
    private readonly notifications: NotificationPort | null = null,
    // `COLLECT_MIN_BATCH` / `COLLECT_MAX_WAIT_SECONDS`: see `collectableToGather`.
    @Optional()
    @Inject(COLLECT_GATHERING)
    private readonly gathering: GatheringPolicy = COLLECT_GATHERING_FROM_ENV,
  ) {}

  /** One pass. Returns how many payments were booked as collected. */
  async run(): Promise<number> {
    let booked = 0;
    const exclusions = this.exclusions();
    const pass = await this.startPass(exclusions);

    // Rail A, a blocked provider's withheld credits first: released to the buyer.
    try {
      await this.refundBlockedRailA(pass);
    } catch (error) {
      this.logger.error(`Releasing blocked providers' rail-A credits threw: ${describe(error)}`);
    }
    // Rail A: the ledger only. One bad row must not stop the rest, or rail B.
    for (const row of await this.payments.findCollectable(
      PaymentRail.RAIL_A_PER_CALL,
      RAIL_A_BATCH,
      exclusions,
    )) {
      if (this.providerBlockCause(row, pass)) continue;
      try {
        await this.intents.bookHeldCollected(row.organizationId, row.id, null);
        booked += 1;
      } catch (error) {
        await this.backOff(row, error);
      }
    }
    if (!this.held) return booked;

    // Refunds first: a blocked provider's payments leave the hold before
    // anything else is sent on the shared key.
    try {
      await this.refundBlocked(pass);
    } catch (error) {
      this.logger.error(`Refunding blocked providers' held payments threw: ${describe(error)}`);
    }

    // Before the timeout (less the race margin): batched, once an asset has
    // gathered enough. After it: `passTimeout`, every pass.
    booked += await this.collectRailB(await this.collectableToGather(exclusions), pass);
    booked += await this.passTimeout(pass);

    try {
      await this.pageBlockedNearTimeout(pass);
    } catch (error) {
      this.logger.error(`Paging blocked providers' held payments threw: ${describe(error)}`);
    }
    return booked;
  }

  /**
   * The rail-B payments the batched collect sends this pass: of each asset
   * that has gathered enough (`settlement-gathering.constants.ts`, owner
   * decision 2026-10-30) — at least `COLLECT_MIN_BATCH` collectable, the
   * oldest collectable for `COLLECT_MAX_WAIT_SECONDS`, or one close to the
   * 7-day timeout — and of no other.
   *
   * Only this path gathers. Blocked-provider refunds, the timeout queue and
   * rail A run every pass; an upheld dispute's refund is not this job's (its
   * `disputeOutcome` keeps the row out of collection). Waiting here starts
   * only after `collectableAt`, when a new dispute is no longer guaranteed a
   * refund, so it adds no refund right; it delays the provider's credit,
   * which is booked only once the chain says `COLLECTED`. A failed count
   * collects as before.
   */
  private async collectableToGather(
    exclusions: RedemptionExclusions,
  ): Promise<PaymentIntentEntity[]> {
    const beforeSeconds = HELD_TIMEOUT_SECONDS - TIMEOUT_RACE_MARGIN_SECONDS;
    let ready: ReadonlySet<string> | null = null;
    if (this.gathering.minBatch > 1) {
      try {
        const summary = await this.payments.summarizeCollectable(
          PaymentRail.RAIL_B_VOUCHER,
          beforeSeconds,
        );
        const now = Date.now();
        ready = new Set(
          [...summary]
            .filter(([, waiting]) =>
              gatheringReady(
                this.gathering,
                {
                  count: waiting.count,
                  oldestAt: waiting.oldestCollectableAt,
                  // Where the batched path hands the oldest to the timeout queue.
                  earliestDeadlineAt: waiting.oldestCollectableAt
                    ? new Date(waiting.oldestCollectableAt.getTime() + beforeSeconds * 1000)
                    : null,
                },
                now,
                EVM_FEE_CAP_WAIVED_WITHIN_SECONDS,
              ),
            )
            .map(([asset]) => asset),
        );
        if (ready.size === 0) return [];
      } catch (error) {
        this.logger.warn(`Gathering check failed; collecting as before: ${describe(error)}`);
        ready = null;
      }
    }
    const rows = await this.payments.findCollectable(
      PaymentRail.RAIL_B_VOUCHER,
      MAX_HELD_BATCH * 4,
      exclusions,
      beforeSeconds,
    );
    const gate = ready;
    return gate === null ? rows : rows.filter((row) => gate.has(row.assetId));
  }

  /**
   * Past (or about to pass) the chain's timeout: an undisputed (or rejected)
   * payment is collected for the provider, singly; a disputed one, or a blocked
   * provider's, is only synced — booked if someone collected it (or the refund
   * landed) — paged while a dispute still holds it, and backed off.
   */
  private async passTimeout(pass: Pass): Promise<number> {
    let booked = await this.collectRailB(
      await this.payments.findTimedOutCollectable(
        PaymentRail.RAIL_B_VOUCHER,
        pass.exclude,
        HELD_TIMEOUT_SECONDS - TIMEOUT_RACE_MARGIN_SECONDS,
        MAX_HELD_BATCH,
      ),
      pass,
    );
    for (const row of await this.payments.findHeldPastTimeout(
      PaymentRail.RAIL_B_VOUCHER,
      pass.exclude,
      HELD_TIMEOUT_SECONDS,
      MAX_HELD_BATCH,
    )) {
      try {
        booked += await this.sync(row, pass);
      } catch (error) {
        await this.backOff(row, error);
      }
    }
    return booked;
  }

  /**
   * Books what the chain did to a held payment past the timeout that is never
   * sent; while still held it is paged (a dispute's) and backed off, so it
   * does not sit at the head of the queue.
   */
  private async sync(row: PaymentIntentEntity, pass: Pass): Promise<number> {
    const held = this.held as HeldPaymentsPort;
    const record = await held.readHeld(row.assetId as AssetId, this.keyOf(row));
    if (record?.status === HeldStatus.COLLECTED || record?.status === HeldStatus.REFUNDED) {
      return this.book(row, record.status, null, pass);
    }
    if (!this.providerBlockCause(row, pass)) {
      await this.alerts.emit({
        severity: AlertSeverity.CRITICAL,
        name: HELD_PAST_TIMEOUT_ALERT,
        summary:
          `Intent ${row.id}: a disputed held payment is past the chain's 7-day timeout — ` +
          `refundHeld is closed and anyone may collect it for the provider`,
        details: { intentId: row.id, disputeOutcome: row.disputeOutcome ?? 'none' },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: row.id,
      });
    }
    await this.backOff(row, new Error('still held past the chain timeout; synced only'));
    return 0;
  }

  private async collectRailB(rows: readonly PaymentIntentEntity[], pass: Pass): Promise<number> {
    if (!this.held || rows.length === 0) return 0;
    let booked = 0;
    for (const [asset, group] of byAsset(rows)) {
      const eligible = group.filter(
        (row) =>
          !pass.chainAccounts.has(row.agentAccount.toLowerCase()) &&
          // Never collected for a blocked provider: the refund pass has it.
          this.providerBlockCause(row, pass) === null,
      );
      // One batch per asset per pass: the redeemer key is shared.
      booked += await this.moveChunk(
        'collect',
        asset as AssetId,
        eligible.slice(0, MAX_HELD_BATCH),
        pass,
      );
    }
    return booked;
  }

  /**
   * Refunds every payment still held of a blocked provider, while
   * `refundHeld` is open: up to {@link MAX_REFUND_BATCHES_PER_ASSET} batches
   * of {@link MAX_HELD_BATCH} per asset per pass. Idempotent: only what the
   * chain still holds is sent, and the booking reads the chain back.
   */
  private async refundBlocked(pass: Pass): Promise<void> {
    const rows = await this.payments.findHeldOfBlockedProviders(
      PaymentRail.RAIL_B_VOUCHER,
      pass.exclude,
      HELD_TIMEOUT_SECONDS,
      MAX_HELD_BATCH * MAX_REFUND_BATCHES_PER_ASSET,
    );
    for (const [asset, group] of byAsset(rows)) {
      for (let at = 0; at < group.length; at += MAX_HELD_BATCH) {
        await this.moveChunk(
          'refund',
          asset as AssetId,
          group.slice(at, at + MAX_HELD_BATCH),
          pass,
        );
      }
    }
  }

  /** Rail A: a blocked provider's withheld credits, released to the buyer (no chain). */
  private async refundBlockedRailA(pass: Pass): Promise<void> {
    for (const row of await this.payments.findHeldOfBlockedProviders(
      PaymentRail.RAIL_A_PER_CALL,
      pass.exclude,
      null,
      RAIL_A_BATCH,
    )) {
      // A chain-blocked payee counts too: a payout to it could not land anyway.
      const cause = this.providerBlockCause(row, pass);
      if (!cause) {
        await this.payments.clearHeldRefundCause(row.organizationId, row.id);
        continue;
      }
      try {
        await this.bookRefund(row, cause, null);
      } catch (error) {
        await this.backOff(row, error);
      }
    }
  }

  /**
   * Collects or refunds one chunk of one asset. Only what the chain still
   * holds goes into a transaction: a record already collected or refunded (a
   * booking that did not land) is booked. A record at or near the timeout is
   * sent singly ({@link TIMEOUT_RACE_MARGIN_SECONDS}); the rest go in one
   * batch, and singly — a few, each with its own back-off — if it is refused.
   * Returns how many were booked as collected.
   */
  private async moveChunk(
    move: HeldMove,
    asset: AssetId,
    rows: readonly PaymentIntentEntity[],
    pass: Pass,
  ): Promise<number> {
    const held = this.held as HeldPaymentsPort;
    let booked = 0;

    const batchable: PaymentIntentEntity[] = [];
    const late: PaymentIntentEntity[] = [];
    for (const row of rows) {
      try {
        const record = await held.readHeld(asset, this.keyOf(row));
        if (record?.status === HeldStatus.HELD) {
          // Past the timeout `refundHeld` is closed: nothing to send (paged).
          if (move === 'refund' && pastTimeout(record.collectableAt)) continue;
          const isLate = nearTimeout(record.collectableAt) || nearTimeout(row.collectableAt);
          (isLate ? late : batchable).push(row);
        } else if (record === null || record.status === HeldStatus.NONE) {
          // No record where one must be (a lagging node, a wrong deployment):
          // back off rather than read it again every minute.
          await this.backOff(row, new Error(`held() read ${record?.status ?? 'nothing'}`));
        } else booked += await this.book(row, record.status, null, pass);
      } catch (error) {
        await this.backOff(row, error);
      }
    }

    let singles = late.slice(0, MAX_TIMEOUT_SINGLES_PER_PASS);
    const toSend = await this.sendable(move, batchable, pass);
    if (toSend.length > 0) {
      try {
        const { txRef } = await this.send(
          move,
          asset,
          toSend.map((row) => this.keyOf(row)),
        );
        for (const row of toSend) {
          if (move === 'refund') pass.refunded.add(row.id);
          booked += await this.book(row, done(move), txRef, pass);
        }
      } catch (error) {
        // Refused in simulation, or failed: singly, a few per pass, each with
        // its own back-off, so one paused or blocked party cannot stop the rest.
        this.logger.warn(
          `${move}HeldBatch of ${toSend.length} on ${asset} failed (${describe(error)}); ` +
            `sending up to ${MAX_SINGLES_PER_PASS} singly`,
        );
        singles = [...toSend.slice(0, MAX_SINGLES_PER_PASS), ...singles];
      }
    }
    for (const row of singles) booked += await this.sendOne(move, asset, row, pass);
    return booked;
  }

  /**
   * The rows still to send, the block re-read just before the transaction (a
   * block added or lifted since the pass started): a collect never goes out
   * for a provider blocked now, a refund only for one still blocked. A refund's
   * cause is recorded on the row first, so its booking does not depend on the
   * block still standing then.
   */
  private async sendable(
    move: HeldMove,
    rows: readonly PaymentIntentEntity[],
    pass: Pass,
  ): Promise<PaymentIntentEntity[]> {
    const out: PaymentIntentEntity[] = [];
    for (const row of rows) {
      const cause = this.providerBlockCause(row, pass);
      if (move === 'collect') {
        if (cause === null) out.push(row);
        continue;
      }
      if (cause === null) {
        // Unblocked, and the chain still holds it: back to plain collection.
        if (recordedCause(row))
          await this.payments.clearHeldRefundCause(row.organizationId, row.id);
        continue;
      }
      await this.payments.recordHeldRefundCause(row.organizationId, row.id, cause);
      pass.causes.set(row.id, cause);
      out.push(row);
    }
    return out;
  }

  /**
   * One record, one transaction. A failure is answered by reading `held()`:
   * a stranger may have collected it first (anyone may, past the timeout), or
   * an earlier send landed — a record no longer `HELD` is booked, not retried.
   */
  private async sendOne(
    move: HeldMove,
    asset: AssetId,
    row: PaymentIntentEntity,
    pass: Pass,
  ): Promise<number> {
    const held = this.held as HeldPaymentsPort;
    try {
      if ((await this.sendable(move, [row], pass)).length === 0) return 0;
      const { txRef } = await this.send(move, asset, [this.keyOf(row)]);
      if (move === 'refund') pass.refunded.add(row.id);
      return await this.book(row, done(move), txRef, pass);
    } catch (error) {
      try {
        const record = await held.readHeld(asset, this.keyOf(row));
        if (record?.status === HeldStatus.COLLECTED || record?.status === HeldStatus.REFUNDED) {
          return await this.book(row, record.status, null, pass);
        }
      } catch {
        // Unreadable: backed off below, read again on the next try.
      }
      await this.backOff(row, error);
      return 0;
    }
  }

  private send(move: HeldMove, asset: AssetId, keys: readonly HeldKey[]) {
    const held = this.held as HeldPaymentsPort;
    return move === 'collect' ? held.collect(asset, keys) : held.refund(asset, keys);
  }

  /**
   * Books a chain status for a row; with a transaction, the status is read
   * back first. Returns 1 when it was a collect.
   *
   * A `REFUNDED` is always this backend's (only the redeemer can refund): an
   * upheld dispute's refund, or else the provider's forfeit — under the cause
   * the block gives now, the one recorded before the send, or
   * {@link REFUNDED_BY_REDEEMER_CAUSE}.
   */
  private async book(
    row: PaymentIntentEntity,
    status: HeldStatus | null,
    txRef: string | null,
    pass: Pass,
  ): Promise<number> {
    const held = this.held as HeldPaymentsPort;
    const confirmed = txRef
      ? (await held.readHeld(row.assetId as AssetId, this.keyOf(row)))?.status
      : status;
    if (confirmed === HeldStatus.COLLECTED) {
      await this.intents.bookHeldCollected(row.organizationId, row.id, txRef);
      return 1;
    }
    if (confirmed !== HeldStatus.REFUNDED) return 0;
    pass.refunded.add(row.id);
    if (row.disputeOutcome === 'UPHELD') {
      await this.intents.refundHeldForDispute(row.organizationId, row.id, 'DISPUTE_UPHELD');
      return 0;
    }
    const cause =
      this.providerBlockCause(row, pass) ??
      pass.causes.get(row.id) ??
      recordedCause(row) ??
      REFUNDED_BY_REDEEMER_CAUSE;
    await this.bookRefund(row, cause, txRef);
    return 0;
  }

  /** Books a forfeit refund, and tells the buyer of each open dispute it settled. */
  private async bookRefund(
    row: PaymentIntentEntity,
    cause: string,
    txRef: string | null,
  ): Promise<void> {
    const { disputeIds } = await this.intents.bookBlockedProviderRefund(
      row.organizationId,
      row.id,
      cause,
      txRef,
    );
    for (const disputeId of disputeIds) {
      try {
        await this.notifications?.notify({
          organizationId: row.organizationId,
          event: NotificationEvent.CALL_DISPUTE_REFUNDED,
          title: 'Your disputed call was refunded',
          body:
            'The provider of a call you disputed was blocked, and its payment went back to ' +
            'your balance. Your dispute stays open for a decision.',
          subjectType: 'call_dispute',
          subjectId: disputeId,
          dedupeKey: `${NotificationEvent.CALL_DISPUTE_REFUNDED}:${disputeId}`,
          // Sent to the buyer only; `role` as on every call_dispute.* payload.
          payload: { disputeId, intentId: row.id, refundState: 'REFUNDED', role: 'buyer' },
        });
      } catch (error) {
        this.logger.error(`Call dispute ${disputeId}: could not notify: ${describe(error)}`);
      }
    }
  }

  /**
   * Pages every blocked provider's payment still held from a day before the
   * timeout to a day after it — once per day for each side of the timeout —
   * unless this pass refunded it, or `held()` says it has moved (booked then).
   */
  private async pageBlockedNearTimeout(pass: Pass): Promise<void> {
    const held = this.held as HeldPaymentsPort;
    const rows = await this.payments.findBlockedHeldNearTimeout(
      PaymentRail.RAIL_B_VOUCHER,
      pass.exclude,
      HELD_TIMEOUT_SECONDS,
      BLOCKED_REFUND_WARN_SECONDS,
      BLOCKED_PAGE_PAST_SECONDS,
      MAX_HELD_BATCH,
    );
    for (const row of rows) {
      if (pass.refunded.has(row.id)) continue;
      // Backing off (its refund keeps failing): paged on the mirror, no read.
      const backingOff = row.heldRetryAt !== null && row.heldRetryAt.getTime() > Date.now();
      try {
        const record = backingOff
          ? null
          : await held.readHeld(row.assetId as AssetId, this.keyOf(row));
        if (record?.status === HeldStatus.COLLECTED || record?.status === HeldStatus.REFUNDED) {
          await this.book(row, record.status, null, pass);
          continue;
        }
      } catch {
        // Unreadable: paged on the mirror.
      }
      const timeoutAt = new Date(
        (row.collectableAt as Date).getTime() + HELD_TIMEOUT_SECONDS * 1000,
      );
      const past = Date.now() >= timeoutAt.getTime();
      await this.alerts.emit({
        severity: AlertSeverity.CRITICAL,
        name: BLOCKED_HELD_UNREFUNDED_ALERT,
        summary:
          `Intent ${row.id}: a blocked provider's held payment is not refunded and the ` +
          `chain's timeout ${past ? 'has passed' : 'is less than 24 h away'} ` +
          `(${timeoutAt.toISOString()}) — after it refundHeld is closed and anyone may ` +
          `collect it for the provider`,
        details: {
          intentId: row.id,
          providerId: row.providerId ?? 'none',
          cause: this.providerBlockCause(row, pass) ?? 'unknown',
          lastError: row.heldLastError ?? 'none',
        },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: `${row.id}:${past ? 'past' : 'near'}`,
        // Each side of the timeout lasts a day: one page each.
        suppressionWindowSeconds: BLOCKED_REFUND_WARN_SECONDS,
      });
    }
  }

  private async backOff(row: PaymentIntentEntity, error: unknown): Promise<void> {
    this.logger.warn(`Held payment ${row.id}: ${describe(error)}; backing off`);
    await this.payments.recordHeldFailure(row.organizationId, row.id, describe(error));
  }

  private keyOf(row: PaymentIntentEntity): HeldKey {
    return { payer: row.agentAccount as AccountId, seq: row.voucherSeq as string };
  }

  /**
   * Why the row's provider is blocked NOW, in the redemption job's names
   * (`VoucherRedemptionService.providerBlockCause`), or `null`: its
   * organization or payout wallet on the platform blocklist (read live), or
   * the payout address on its chain's (as the pass read it).
   */
  private providerBlockCause(row: PaymentIntentEntity, pass: Pass): string | null {
    const blocked = this.blocklist.firstBlocked([
      { role: BlockedRole.PROVIDER, kind: BlockSubjectKind.ORGANIZATION, subject: row.providerId },
      { role: BlockedRole.PAYEE, kind: BlockSubjectKind.WALLET, subject: row.providerAccount },
    ]);
    if (blocked) return blocked.role === BlockedRole.PROVIDER ? 'ProviderBlocked' : 'PayeeBlocked';
    if (row.providerAccount && pass.chainAccounts.has(row.providerAccount.toLowerCase())) {
      return 'PayeeBlockedOnChain';
    }
    return null;
  }

  /** The off-chain blocklist, as the redemption job reads it. */
  private exclusions(): RedemptionExclusions {
    const organizationIds: string[] = [];
    const walletKeys: string[] = [];
    for (const hit of this.blocklist.list()) {
      const key = subjectKey(hit.subjectKind, hit.subject);
      if (!key) continue;
      (hit.subjectKind === BlockSubjectKind.ORGANIZATION ? organizationIds : walletKeys).push(key);
    }
    return { organizationIds, walletKeys, chainAccounts: [] };
  }

  /** The off-chain blocklist plus the on-chain blocklist of every chain something is held on. */
  private async startPass(exclusions: RedemptionExclusions): Promise<Pass> {
    const chainAccounts = new Set<string>();
    if (this.held && this.chainState?.blockedAccounts) {
      const chains = new Set(
        (await this.payments.findHeldAssetIds(PaymentRail.RAIL_B_VOUCHER)).map((asset) =>
          chainIdOf(asset as AssetId),
        ),
      );
      for (const chain of chains) {
        for (const account of await this.chainBlocked(chain)) chainAccounts.add(account);
      }
    }
    return {
      exclude: { ...exclusions, chainAccounts: [...chainAccounts] },
      chainAccounts,
      refunded: new Set(),
      causes: new Map(),
    };
  }

  /** The on-chain blocklist of a chain, lower-case; empty when unknown. */
  private async chainBlocked(chainId: ChainId): Promise<readonly string[]> {
    if (!this.chainState?.blockedAccounts) return [];
    try {
      const accounts = await this.chainState.blockedAccounts(chainId);
      return accounts.map((account) => account.toLowerCase());
    } catch {
      return [];
    }
  }
}

/** The provider-block cause recorded on the row, matched by prefix, or `null`. */
function recordedCause(row: PaymentIntentEntity): string | null {
  const stored = row.redemptionLastError;
  if (!stored) return null;
  return PROVIDER_BLOCK_CAUSES.find((cause) => stored.startsWith(cause)) ?? null;
}

/** The chain status a landed move leaves. */
function done(move: HeldMove): HeldStatus {
  return move === 'collect' ? HeldStatus.COLLECTED : HeldStatus.REFUNDED;
}

/** Whether the chain's timeout has passed for a record collectable at `at`. */
function pastTimeout(at: Date | null): boolean {
  return at !== null && Date.now() >= at.getTime() + HELD_TIMEOUT_SECONDS * 1000;
}

/** {@link pastTimeout}, {@link TIMEOUT_RACE_MARGIN_SECONDS} early: sent singly from then. */
function nearTimeout(at: Date | null): boolean {
  return (
    at !== null &&
    Date.now() >= at.getTime() + (HELD_TIMEOUT_SECONDS - TIMEOUT_RACE_MARGIN_SECONDS) * 1000
  );
}

function byAsset(rows: readonly PaymentIntentEntity[]): Map<string, PaymentIntentEntity[]> {
  const groups = new Map<string, PaymentIntentEntity[]>();
  for (const row of rows) groups.set(row.assetId, [...(groups.get(row.assetId) ?? []), row]);
  return groups;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
