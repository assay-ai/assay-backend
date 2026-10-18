import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { HELD_TIMEOUT_SECONDS } from '@modules/payment/ports/held-payments.port';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { CallDisputeService, PROVIDER_REPLY_HOURS } from './call-dispute.service';

const HOUR_MS = 3_600_000;

/** The decision SLA, from the filing (analysis §5). */
export const CALL_DISPUTE_SLA = Object.freeze({
  providerReplyMs: PROVIDER_REPLY_HOURS * HOUR_MS,
  pageMs: 48 * HOUR_MS,
  decideMs: 72 * HOUR_MS,
  lastPageMs: 6 * 24 * HOUR_MS,
});

export const CALL_DISPUTE_SLA_ALERT = 'call_dispute_sla';

interface OpenRow {
  readonly id: string;
  readonly created_at: Date;
  readonly provider_response: string | null;
  readonly provider_silent_at: Date | null;
  readonly paged_48h_at: Date | null;
  readonly paged_72h_at: Date | null;
  readonly paged_6d_at: Date | null;
  readonly refund_guaranteed: boolean;
}

/**
 * The call-dispute decision SLA (G3.B1), every few minutes:
 *
 * - 24 h with no provider reply: the provider is marked silent (it can no
 *   longer reply);
 * - 48 h with no decision: an operator is paged;
 * - 72 h with no decision: auto-upheld if the provider stayed silent; if it
 *   replied, the payment stays held and an operator is paged again;
 * - 6 days with no decision: paged again, before the chain's 7-day timeout;
 * - past the timeout the held payment is the provider's (anyone may collect;
 *   `HeldCollectionService` does), so a guaranteed refund is no longer
 *   possible: the dispute is marked `NOT_REFUNDABLE`, collected to the provider.
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
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
  ) {}

  async sweep(now: Date = new Date()): Promise<{ autoUpheld: number; paged: number }> {
    const rows = (await this.dataSource.query(
      `SELECT "id", "created_at", "provider_response", "provider_silent_at", "paged_48h_at",
              "paged_72h_at", "paged_6d_at", "refund_guaranteed"
         FROM "disputes"
        WHERE "intent_id" IS NOT NULL AND "state" = 'OPEN' AND "created_at" <= $1
        ORDER BY "created_at" ASC
        LIMIT 500`,
      [new Date(now.getTime() - CALL_DISPUTE_SLA.providerReplyMs)],
    )) as OpenRow[];

    let autoUpheld = 0;
    let paged = 0;
    for (const row of rows) {
      const age = now.getTime() - new Date(row.created_at).getTime();
      const silent = row.provider_response === null;

      if (silent && !row.provider_silent_at) {
        await this.mark(row.id, 'provider_silent_at', now);
      }
      if (age >= CALL_DISPUTE_SLA.decideMs && silent) {
        if (await this.disputes.autoUphold(row.id)) autoUpheld += 1;
        continue;
      }
      if (age >= CALL_DISPUTE_SLA.lastPageMs && !row.paged_6d_at) {
        if (await this.mark(row.id, 'paged_6d_at', now)) {
          await this.page(
            row,
            AlertSeverity.CRITICAL,
            'six days undecided; the held payment ' +
              'goes to the provider at the chain’s 7-day timeout',
          );
          paged += 1;
        }
      } else if (age >= CALL_DISPUTE_SLA.decideMs && !row.paged_72h_at) {
        if (await this.mark(row.id, 'paged_72h_at', now)) {
          await this.page(
            row,
            AlertSeverity.WARN,
            '72 hours undecided; the provider replied, ' +
              'so it stays held until an operator decides',
          );
          paged += 1;
        }
      } else if (age >= CALL_DISPUTE_SLA.pageMs && !row.paged_48h_at) {
        if (await this.mark(row.id, 'paged_48h_at', now)) {
          await this.page(row, AlertSeverity.WARN, '48 hours undecided');
          paged += 1;
        }
      }
    }

    await this.markTimedOut();
    return { autoUpheld, paged };
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
          AND d."state" = 'OPEN' AND d."refund_state" IS NULL
          AND i."held_status" = 'COLLECTED'
          AND i."collectable_at" + make_interval(secs => $1) <= now()
        RETURNING d."id"`,
      [HELD_TIMEOUT_SECONDS],
    )) as unknown;
    const count = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0].length : 0;
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
    return Array.isArray(result) && Array.isArray(result[0]) ? result[0].length > 0 : false;
  }

  private async page(row: OpenRow, severity: AlertSeverity, why: string): Promise<void> {
    try {
      await this.alerts.emit({
        severity,
        name: CALL_DISPUTE_SLA_ALERT,
        summary: `Call dispute ${row.id}: ${why}`,
        details: { disputeId: row.id, refundGuaranteed: String(row.refund_guaranteed) },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: `${row.id}:${why.slice(0, 16)}`,
      });
    } catch (error) {
      this.logger.error(`Call dispute ${row.id}: could not page: ${(error as Error).message}`);
    }
  }
}
