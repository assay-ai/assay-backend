import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import {
  DuePaymentIntent,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import { MCP_VERIFICATION_DEADLINE_REASON } from '@modules/mcp/constants/mcp.constants';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import {
  PAYMENT_INTENT_EXPIRY_REASON,
  PAYMENT_INTENT_EXPIRY_SWEEP_BATCH,
  PAYMENT_INTENT_HOLD_BACKSTOP_REASON,
  PAYMENT_INTENT_HOLD_REPAIR_REASON,
  PAYMENT_INTENT_VERDICT_DEADLINE_SECONDS,
} from '../constants/payment-intent.constants';
import {
  BUYER_DEBT_WRITE_OFF_DAYS,
  UNCOLLECTED_PREFIX,
  VOUCHER_REDEMPTION_ALERTS,
} from '../constants/voucher-redemption.constants';
import { PaymentErrorCode } from '../errors/payment.errors';
import {
  HoldEffect,
  PAYMENT_INTENT_EXPIRABLE_STATUSES,
  PAYMENT_INTENT_HOLD_BACKSTOP_STATUSES,
  findPaymentIntentTransition,
} from '../domain/payment-intent-transitions';
import { PaymentIntentStatus } from '../ports/payment.types';
import { PaymentIntentService } from './payment-intent.service';

export interface PaymentIntentSweepReport {
  /** Intents moved to `EXPIRED` on this pass. */
  readonly expired: number;
  /** Holds actually returned to the agent — releases that were a no-op are not counted. */
  readonly holdsReleased: number;
  /** Intents a worker never resolved, expired by the 24-hour hold backstop. */
  readonly backstopped: number;
  /** Rail-B intents settled as served because their verdict missed the deadline. */
  readonly verdictDeadlineSettled: number;
  /** Holds returned by the repair pass, i.e. left open by an earlier pass that died. */
  readonly repaired: number;
  /** Buyer debts written off: unsettled for `BUYER_DEBT_WRITE_OFF_DAYS`, provider not paid. */
  readonly debtsWrittenOff: number;
  /** Intents this pass could not finish. They are retried on the next one. */
  readonly failed: number;
}

/**
 * The expiry sweep.
 *
 * Two passes, because there are two ways an intent can be left holding money it
 * has no claim to:
 *
 * 1. **expire** — the intent's five minutes elapsed while it was still in a
 *    state the sweep may act on. Move it to `EXPIRED`, then release.
 * 2. **repair** — an earlier pass moved an intent to `EXPIRED` and died before
 *    the ledger call landed. Nothing else will ever look at that intent again:
 *    it is no longer expirable, so pass 1 cannot see it. This pass is not
 *    merely faster than the alternative, it **is** the alternative — the
 *    24-hour hold expiry this comment used to name is unimplemented
 *    (`ledger_holds.expires_at` has no reader; see `PAYMENT_INTENT_HOLD_TTL_MS`),
 *    so without this pass the money would never come back at all.
 *
 * Note what that means for the states this sweep cannot reach. The repair query
 * is gated on `status = EXPIRED`, so a terminal intent holding money — a
 * `SETTLED` row whose commit failed, say — is invisible to both passes and to
 * everything else. That gap is real and unclosed.
 *
 * The order inside pass 1 is the part worth defending. The status moves
 * **first**, and only then is the hold released. The other order would release
 * money and *then* discover the intent had already moved on to
 * `PROVIDER_EXECUTING` — funds returned to the agent for a call that is still
 * running. Taking the compare-and-swap first means the sweep either owns the
 * intent outright or does nothing at all; a crash in the window between then
 * leaves a released-nothing intent that pass 2 picks up.
 *
 * A third pass runs first: the **deadline on verdicts**. A rail-B intent still
 * `VERIFYING` `PAYMENT_INTENT_VERDICT_DEADLINE_SECONDS` after its voucher's
 * `expiresAt` is settled as served and unverified (see
 * {@link settleOverdueVerdicts}), so its voucher is redeemed before the chain
 * refuses it. It runs before the 24-hour backstop, which would otherwise
 * release the hold of a call that was served.
 *
 * Runs on the scheduler, which is a single instance by design. It is written to
 * be safe if that stops being true anyway: the compare-and-swap gives an intent
 * to exactly one sweeper, and the ledger's release is idempotent.
 */
@Injectable()
export class PaymentIntentExpiryService {
  private readonly logger = new Logger(PaymentIntentExpiryService.name);

  constructor(
    private readonly intents: PaymentIntentRepository,
    private readonly paymentIntents: PaymentIntentService,
    @Optional() @Inject(ALERT_PORT) private readonly alerts: AlertPort | null = null,
  ) {}

  async sweep(
    now: Date = new Date(),
    limit: number = PAYMENT_INTENT_EXPIRY_SWEEP_BATCH,
  ): Promise<PaymentIntentSweepReport> {
    const deadline = await this.settleOverdueVerdicts(now, limit);
    let failed = deadline.failed;

    const due = await this.intents.findDueForExpiry(now, PAYMENT_INTENT_EXPIRABLE_STATUSES, limit);

    let expired = 0;
    let holdsReleased = 0;

    for (const candidate of due) {
      try {
        const released = await this.expire(candidate, PAYMENT_INTENT_EXPIRY_REASON);
        expired += 1;
        holdsReleased += released ? 1 : 0;
      } catch (error) {
        failed += 1;
        this.logger.error(
          `Intent ${candidate.id}: expiry sweep failed from ${candidate.status}. ${describe(error)}`,
        );
      }
    }

    // The 24-hour backstop: calls a worker took and never resolved. A worker
    // that resolves first wins the compare-and-set and this candidate fails
    // here with PAYMENT_INVALID_STATE_TRANSITION, which is counted, not retried.
    let backstopped = 0;
    const stuck = await this.intents.findDueForHoldBackstop(
      now,
      PAYMENT_INTENT_HOLD_BACKSTOP_STATUSES,
      limit,
    );
    for (const candidate of stuck) {
      try {
        const released = await this.expire(candidate, PAYMENT_INTENT_HOLD_BACKSTOP_REASON);
        backstopped += 1;
        holdsReleased += released ? 1 : 0;
        this.logger.warn(
          `Intent ${candidate.id}: ${PAYMENT_INTENT_HOLD_BACKSTOP_REASON} (was ${candidate.status})`,
        );
      } catch (error) {
        failed += 1;
        this.logger.error(
          `Intent ${candidate.id}: hold backstop failed from ${candidate.status}. ${describe(error)}`,
        );
      }
    }

    const { repaired, repairFailures } = await this.repair(limit);
    const writeOff = await this.writeOffDebts(now, limit);
    failed += writeOff.failed;
    const debtsWrittenOff = writeOff.writtenOff;

    const verdictDeadlineSettled = deadline.settled;
    if (
      expired ||
      backstopped ||
      verdictDeadlineSettled ||
      repaired ||
      debtsWrittenOff ||
      failed ||
      repairFailures
    ) {
      this.logger.log(
        `Expiry sweep: ${expired} expired, ${backstopped} backstopped, ` +
          `${verdictDeadlineSettled} settled past the verdict deadline, ` +
          `${holdsReleased} holds released, ${repaired} repaired, ` +
          `${debtsWrittenOff} debts written off, ${failed + repairFailures} failed`,
      );
    }

    return {
      expired,
      backstopped,
      verdictDeadlineSettled,
      holdsReleased,
      repaired,
      debtsWrittenOff,
      failed: failed + repairFailures,
    };
  }

  /**
   * Writes off buyer debts unsettled for {@link BUYER_DEBT_WRITE_OFF_DAYS}
   * since they lapsed (owner decision, no-platform-debt design step 10): the
   * buyer's hold is released and **the provider is not paid** — nobody owes
   * anything afterwards, the platform least of all. Recorded on the intent as
   * `uncollected:<cause>` BEFORE the release, so a crash between the two
   * leaves an open hold the next pass writes off again (the release is
   * idempotent).
   */
  private async writeOffDebts(
    now: Date,
    limit: number,
  ): Promise<{ writtenOff: number; failed: number }> {
    const before = new Date(now.getTime() - BUYER_DEBT_WRITE_OFF_DAYS * 24 * 3_600_000);
    const due = await this.intents.findDueForWriteOff(before, limit);
    let writtenOff = 0;
    let failed = 0;
    for (const candidate of due) {
      try {
        const intent = await this.paymentIntents.findById(candidate.organizationId, candidate.id);
        const cause = (await this.lapseCauseOf(candidate)) ?? 'unknown';
        const reason = cause.startsWith(UNCOLLECTED_PREFIX)
          ? cause
          : `${UNCOLLECTED_PREFIX}${cause}`;
        await this.intents.markWrittenOff(candidate.organizationId, candidate.id, reason);
        if (candidate.holdId) {
          await this.paymentIntents.releaseHold({
            organizationId: candidate.organizationId,
            id: candidate.id,
            holdId: candidate.holdId,
          });
        }
        writtenOff += 1;
        this.logger.warn(
          `Intent ${candidate.id}: buyer debt unsettled for ${BUYER_DEBT_WRITE_OFF_DAYS} days — ` +
            `written off (${reason}). The buyer's hold is released and the provider is not paid.`,
        );
        await this.alerts
          ?.emit({
            severity: AlertSeverity.WARN,
            name: VOUCHER_REDEMPTION_ALERTS.DEBT_WRITTEN_OFF,
            summary:
              `A buyer debt was not settled within ${BUYER_DEBT_WRITE_OFF_DAYS} days and was ` +
              `written off: the provider is not paid, and nobody owes it`,
            details: {
              intentId: candidate.id,
              buyer: intent.agentAccount,
              providerId: intent.providerId ?? 'unknown',
              amount: `${intent.price.amount} ${intent.price.asset}`,
              reason,
            },
            aggregation: AlertAggregation.PER_EVENT,
          })
          .catch(() => undefined);
      } catch (error) {
        failed += 1;
        this.logger.error(`Intent ${candidate.id}: debt write-off failed. ${describe(error)}`);
      }
    }
    return { writtenOff, failed };
  }

  /** The refusal the debt lapsed on, as recorded on the intent. */
  private async lapseCauseOf(candidate: DuePaymentIntent): Promise<string | null> {
    const entity = await this.intents.findOneBy({
      organizationId: candidate.organizationId,
      id: candidate.id,
    });
    return entity?.redemptionLastError ?? null;
  }

  /**
   * Settles as served and unverified every rail-B intent whose verdict missed
   * its deadline — the same `VERIFYING → SETTLED` the MCP path takes when the
   * verification enqueue fails, with its own reason. The hold stays open:
   * `resolve()` never commits a rail-B hold, and the redemption job collects
   * it from the buyer's escrow — or, for a row already past the latest its
   * voucher can be redeemed (`PAYMENT_INTENT_VERDICT_DEADLINE_LATEST_SECONDS`),
   * `resolve()` makes it buyer debt at once.
   *
   * Idempotent through the status compare-and-swap. A verdict that lands
   * first wins and this candidate is skipped (a lost race, not a failure); a
   * verdict that lands after loses its own CAS and moves no money.
   */
  private async settleOverdueVerdicts(
    now: Date,
    limit: number,
  ): Promise<{ settled: number; failed: number }> {
    const overdue = await this.intents.findDueForVerdictDeadline(
      now,
      PAYMENT_INTENT_VERDICT_DEADLINE_SECONDS,
      limit,
    );

    let settled = 0;
    let failed = 0;
    for (const candidate of overdue) {
      try {
        const intent = await this.paymentIntents.findById(candidate.organizationId, candidate.id);
        await this.paymentIntents.resolve(
          candidate.organizationId,
          candidate.id,
          PaymentIntentStatus.VERIFYING,
          PaymentIntentStatus.SETTLED,
          { reason: MCP_VERIFICATION_DEADLINE_REASON, settledAmount: intent.price },
        );
        settled += 1;
        this.logger.warn(
          `Intent ${candidate.id}: no verdict ${PAYMENT_INTENT_VERDICT_DEADLINE_SECONDS}s after ` +
            `its voucher expired — settled as served, unverified, for redemption`,
        );
      } catch (error) {
        if (isInvalidStateTransition(error)) continue;
        failed += 1;
        this.logger.error(
          `Intent ${candidate.id}: verdict-deadline settle failed. ${describe(error)}`,
        );
      }
    }
    return { settled, failed };
  }

  /**
   * Expires one intent and returns whether its hold moved money back.
   *
   * The transition table decides whether there is a hold to release at all: a
   * `CREATED` intent never opened one, and the rule for that edge says so
   * (`HoldEffect.NONE`) rather than the sweep inferring it from a null column.
   */
  private async expire(candidate: DuePaymentIntent, reason: string): Promise<boolean> {
    const from = candidate.status as PaymentIntentStatus;

    await this.paymentIntents.transition(
      candidate.organizationId,
      candidate.id,
      from,
      PaymentIntentStatus.EXPIRED,
      { reason },
    );

    const rule = findPaymentIntentTransition(from, PaymentIntentStatus.EXPIRED);
    if (rule?.holdEffect !== HoldEffect.RELEASE || !candidate.holdId) {
      return false;
    }

    return this.paymentIntents.releaseHold({
      organizationId: candidate.organizationId,
      id: candidate.id,
      holdId: candidate.holdId,
    });
  }

  private async repair(limit: number): Promise<{ repaired: number; repairFailures: number }> {
    const stranded = await this.intents.findExpiredWithUnreleasedHold(
      PaymentIntentStatus.EXPIRED,
      limit,
    );

    let repaired = 0;
    let repairFailures = 0;

    for (const candidate of stranded) {
      try {
        await this.paymentIntents.releaseHold({
          organizationId: candidate.organizationId,
          id: candidate.id,
          holdId: candidate.holdId as string,
        });
        repaired += 1;
        this.logger.warn(
          `Intent ${candidate.id}: ${PAYMENT_INTENT_HOLD_REPAIR_REASON}; hold ${candidate.holdId} released`,
        );
      } catch (error) {
        repairFailures += 1;
        this.logger.error(
          `Intent ${candidate.id}: could not release stranded hold ${candidate.holdId}. ${describe(error)}`,
        );
      }
    }

    return { repaired, repairFailures };
  }
}

/** The status compare-and-swap was lost: another writer moved the intent first. */
function isInvalidStateTransition(error: unknown): boolean {
  return (
    (error as { errorCode?: string } | null)?.errorCode ===
    PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
