import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { OperatorRole } from '@modules/operator/domain/override-register';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';
import { OverrideLogService } from '@modules/operator/services/override-log.service';
import { HELD_TIMEOUT_SECONDS } from '@modules/payment/ports/held-payments.port';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { CallDisputeDecision, needsSecondOperator } from '../domain/call-dispute';
import { CALL_DISPUTE_CONFIG, CallDisputeConfig } from '../constants/call-dispute.config';
import {
  CALL_DISPUTE_TARGET,
  CallDisputeService,
  PROVIDER_REPLY_HOURS,
  disputedAmountOf,
} from './call-dispute.service';

const HOUR_MS = 3_600_000;

/** The decision SLA, from the filing (analysis §5). */
export const CALL_DISPUTE_SLA = Object.freeze({
  providerReplyMs: PROVIDER_REPLY_HOURS * HOUR_MS,
  pageMs: 48 * HOUR_MS,
  decideMs: 72 * HOUR_MS,
  lastPageMs: 6 * 24 * HOUR_MS,
});

export const CALL_DISPUTE_SLA_ALERT = 'call_dispute_sla';

/**
 * The SLA's actor in the override register: a SUSPENDED operator with no
 * wallet and no console access, seeded by migration `1761800000002`.
 */
export const SYSTEM_SLA_OPERATOR_ID = '00000000-0000-4000-8000-0000000005a1';
const SYSTEM_SLA_ACTOR: OperatorSession = Object.freeze({
  operatorId: SYSTEM_SLA_OPERATOR_ID,
  subject: 'system:call-dispute-sla',
  displayName: 'Call dispute SLA (system)',
  email: 'call-dispute-sla@system.invalid',
  roles: [OperatorRole.ADJ],
  authorityLimitMinor: null,
});

interface DueRow {
  readonly id: string;
  readonly created_at: Date;
  readonly organization_id: string;
  readonly provider_response: string | null;
  readonly provider_silent_at: Date | null;
  readonly paged_48h_at: Date | null;
  readonly paged_72h_at: Date | null;
  readonly paged_6d_at: Date | null;
  readonly refund_guaranteed: boolean;
}

/**
 * The call-dispute decision SLA (G3.B1), every five minutes, over the disputes
 * whose next mark is DUE (review P2-4: never just the oldest 500):
 *
 * - 24 h with no provider reply: the provider is marked silent (it can no
 *   longer reply);
 * - 48 h undecided: an operator is paged;
 * - 72 h undecided: auto-upheld — logged as `S-14` under the system actor —
 *   only when the refund is guaranteed, the provider stayed silent and the
 *   amount is below the two-person threshold (review P2-3); otherwise paged and
 *   left held;
 * - 6 days undecided, or upheld with the refund still pending: paged again,
 *   before the chain's 7-day timeout;
 * - past the timeout, once the payment was collected to the provider, a
 *   guaranteed refund is marked `NOT_REFUNDABLE`.
 *
 * And the refund job ({@link refundPending}): upheld disputes whose held
 * payment still has to go back are retried every minute, by the scheduler —
 * the process that holds the redeemer key (review P1-2).
 *
 * Each step is a compare-and-swap on its own mark, so a re-run repeats nothing.
 * Deliberately cross-organization: a platform job.
 */
@Injectable()
export class CallDisputeSlaService {
  private readonly logger = new Logger(CallDisputeSlaService.name);

  constructor(
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    private readonly disputes: CallDisputeService,
    private readonly overrides: OverrideLogService,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(CALL_DISPUTE_CONFIG) private readonly config: CallDisputeConfig,
  ) {}

  async sweep(now: Date = new Date()): Promise<{ autoUpheld: number; paged: number }> {
    const at = (ms: number) => new Date(now.getTime() - ms);
    const rows = (await this.dataSource.query(
      `SELECT "id", "created_at", "organization_id", "provider_response", "provider_silent_at",
              "paged_48h_at", "paged_72h_at", "paged_6d_at", "refund_guaranteed"
         FROM "disputes"
        WHERE "intent_id" IS NOT NULL AND "state" = 'OPEN'
          AND (("provider_response" IS NULL AND "provider_silent_at" IS NULL AND "created_at" <= $1)
               OR ("paged_48h_at" IS NULL AND "created_at" <= $2)
               OR ("paged_72h_at" IS NULL AND "created_at" <= $3)
               OR ("paged_6d_at" IS NULL AND "created_at" <= $4))
        ORDER BY "created_at" ASC
        LIMIT 500`,
      [
        at(CALL_DISPUTE_SLA.providerReplyMs),
        at(CALL_DISPUTE_SLA.pageMs),
        at(CALL_DISPUTE_SLA.decideMs),
        at(CALL_DISPUTE_SLA.lastPageMs),
      ],
    )) as DueRow[];

    let autoUpheld = 0;
    let paged = 0;
    for (const row of rows) {
      const age = now.getTime() - new Date(row.created_at).getTime();
      const silent = row.provider_response === null;

      if (silent && !row.provider_silent_at && age >= CALL_DISPUTE_SLA.providerReplyMs) {
        await this.mark(row.id, 'provider_silent_at', now);
      }
      if (age >= CALL_DISPUTE_SLA.decideMs && !row.paged_72h_at) {
        const why = await this.whyNotAutoUphold(row, silent);
        if (why === null && (await this.autoUphold(row))) {
          autoUpheld += 1;
          continue;
        }
        if (why !== null && (await this.mark(row.id, 'paged_72h_at', now))) {
          await this.page(row.id, AlertSeverity.WARN, `72 hours undecided; held — ${why}`);
          paged += 1;
        }
      }
      if (age >= CALL_DISPUTE_SLA.lastPageMs && !row.paged_6d_at) {
        if (await this.mark(row.id, 'paged_6d_at', now)) {
          await this.page(
            row.id,
            AlertSeverity.CRITICAL,
            'six days undecided; the held ' +
              'payment goes to the provider at the chain’s 7-day timeout',
          );
          paged += 1;
        }
        continue;
      }
      if (age >= CALL_DISPUTE_SLA.pageMs && !row.paged_48h_at) {
        if (await this.mark(row.id, 'paged_48h_at', now)) {
          await this.page(row.id, AlertSeverity.WARN, '48 hours undecided');
          paged += 1;
        }
      }
    }

    paged += await this.pageStuckRefunds(now);
    await this.markTimedOut();
    return { autoUpheld, paged };
  }

  /**
   * Upheld disputes whose held payment still has to go back (rail B):
   * `refundHeld`, with the redeemer key, then booked. A failure backs off on
   * the intent and is retried on a later pass.
   */
  async refundPending(limit = 64): Promise<number> {
    const rows = (await this.dataSource.query(
      `SELECT d."id" FROM "disputes" d
         JOIN "payment_intents" i ON i."id" = d."intent_id" AND i."organization_id" = d."organization_id"
        WHERE d."state" = 'UPHELD' AND d."refund_state" = 'PENDING'
          AND (i."held_retry_at" IS NULL OR i."held_retry_at" <= now())
        ORDER BY d."resolved_at" ASC
        LIMIT $1`,
      [limit],
    )) as { id: string }[];
    let refunded = 0;
    for (const row of rows) {
      try {
        const after = await this.disputes.settleRefund(row.id, { chain: true });
        if (after.refundState !== 'PENDING') {
          refunded += 1;
          await this.disputes.announceDecision(after);
        }
      } catch (error) {
        this.logger.warn(
          `Call dispute ${row.id}: refund retry failed: ${(error as Error).message}`,
        );
      }
    }
    return refunded;
  }

  /** `null` when the SLA may auto-uphold; otherwise why a human must decide. */
  private async whyNotAutoUphold(row: DueRow, silent: boolean): Promise<string | null> {
    if (!silent) return 'the provider replied, so an operator decides';
    if (!row.refund_guaranteed) return 'the refund is not guaranteed, so an operator decides';
    const dispute = await this.disputes.requireAny(row.id);
    if (
      needsSecondOperator(
        disputedAmountOf(dispute),
        dispute.decimals ?? 6,
        this.config.twoPersonThresholdUnits,
      )
    ) {
      return 'above the two-person threshold, so two operators decide';
    }
    return null;
  }

  /**
   * The auto-uphold, through the override register as `S-14` under the system
   * actor, in one transaction with the decision; the refund follows (this is
   * the scheduler, so `refundHeld` can be sent). `false` when it could not be
   * taken this pass (decided meanwhile, or not yet redeemed into the hold).
   */
  private async autoUphold(row: DueRow): Promise<boolean> {
    const note =
      'Upheld automatically: the provider did not reply within 24 hours and no decision was ' +
      'made within 72 hours of the filing.';
    try {
      await this.overrides.perform(
        {
          code: 'S-14',
          actor: SYSTEM_SLA_ACTOR,
          targetType: CALL_DISPUTE_TARGET,
          targetId: row.id,
          organizationId: row.organization_id,
          reasonCode: 'AUTO_UPHOLD',
          reason: note,
        },
        async (queryRunner) => {
          const result = await this.disputes.decideWithin(queryRunner, {
            disputeId: row.id,
            decision: CallDisputeDecision.UPHOLD,
            note,
            operatorId: SYSTEM_SLA_OPERATOR_ID,
            resolutionKind: 'AUTO_PLATFORM_MISS',
          });
          return { value: null, before: result.before, after: result.after };
        },
      );
    } catch (error) {
      this.logger.warn(`Call dispute ${row.id}: auto-uphold deferred: ${(error as Error).message}`);
      return false;
    }
    const settled = await this.disputes.settleRefund(row.id, { chain: true });
    await this.disputes.announceDecision(settled);
    return true;
  }

  /** Upheld six days ago and the refund still pending: page, once. */
  private async pageStuckRefunds(now: Date): Promise<number> {
    const rows = (await this.dataSource.query(
      `UPDATE "disputes" SET "paged_6d_at" = $1
        WHERE "intent_id" IS NOT NULL AND "state" = 'UPHELD' AND "refund_state" = 'PENDING'
          AND "paged_6d_at" IS NULL AND "resolved_at" <= $2
        RETURNING "id"`,
      [now, new Date(now.getTime() - CALL_DISPUTE_SLA.lastPageMs)],
    )) as unknown;
    const ids = returnedIds(rows);
    for (const id of ids) {
      await this.page(
        id,
        AlertSeverity.CRITICAL,
        'upheld six days ago and the refund is still ' +
          'pending; refundHeld closes at the chain’s 7-day timeout',
      );
    }
    return ids.length;
  }

  /**
   * A guaranteed dispute whose held payment the chain's timeout gave to the
   * provider (collected past `collectable_at + HELD_TIMEOUT_SECONDS`): a refund
   * is no longer possible.
   */
  private async markTimedOut(): Promise<void> {
    const rows = (await this.dataSource.query(
      `UPDATE "disputes" d
          SET "refund_source" = 'NONE', "refund_state" = 'NOT_REFUNDABLE', "updated_at" = now()
         FROM "payment_intents" i
        WHERE d."intent_id" = i."id" AND d."organization_id" = i."organization_id"
          AND ((d."state" = 'OPEN' AND d."refund_state" IS NULL)
               OR (d."state" = 'UPHELD' AND d."refund_state" = 'PENDING'))
          AND i."held_status" = 'COLLECTED'
          AND i."collectable_at" + make_interval(secs => $1) <= now()
        RETURNING d."id"`,
      [HELD_TIMEOUT_SECONDS],
    )) as unknown;
    const count = returnedIds(rows).length;
    if (count > 0) {
      this.logger.warn(
        `${count} call dispute(s) passed the chain timeout: collected to the provider`,
      );
    }
  }

  private async mark(id: string, column: string, now: Date): Promise<boolean> {
    const result = (await this.dataSource.query(
      `UPDATE "disputes" SET "${column}" = $2 WHERE "id" = $1 AND "${column}" IS NULL
        RETURNING "id"`,
      [id, now],
    )) as unknown;
    return returnedIds(result).length > 0;
  }

  private async page(id: string, severity: AlertSeverity, why: string): Promise<void> {
    try {
      await this.alerts.emit({
        severity,
        name: CALL_DISPUTE_SLA_ALERT,
        summary: `Call dispute ${id}: ${why}`,
        details: { disputeId: id },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: `${id}:${why.slice(0, 16)}`,
      });
    } catch (error) {
      this.logger.error(`Call dispute ${id}: could not page: ${(error as Error).message}`);
    }
  }
}

function returnedIds(result: unknown): string[] {
  const rows =
    Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) ? result[0] : result;
  return Array.isArray(rows) ? rows.map((row: { id: string }) => row.id) : [];
}
