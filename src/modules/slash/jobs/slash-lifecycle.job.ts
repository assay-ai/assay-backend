import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { ArbitrationService } from '../services/arbitration.service';
import { SlashChainRulingService } from '../services/slash-chain-ruling.service';
import { SlashExecutionService } from '../services/slash-execution.service';
import { SlashProposalService } from '../services/slash-proposal.service';

/**
 * The seven steps, on a tick.
 *
 * Modelled on `SlaWindowSweepJob`, including the try/catch: a throw out of a
 * `@Cron` handler is an unhandled rejection that takes the scheduler process
 * down, and the next pass would never run. On this job that failure mode is
 * particularly bad — the pass that stops running is the one that overturns
 * cases we failed to decide, so a crash here would silently convert our own
 * missed deadlines into upheld penalties.
 *
 * Each of the seven is a separate try/catch for the same reason: an RPC outage
 * that stops execution must not stop the two sweepers, and the sweeper that
 * *costs the platform money* must be the least stoppable thing in the file.
 *
 * ## Order within one tick
 *
 * `sweepUndisputed` → (EVM: `followOpenCasesPastDoor`) → `sweepPlatformMisses`
 * → `proposeDue` → `executeDue` → `requestCancelsForClosedCases` →
 * `sweepAdminCancels` → `sweepUnresolvedDisputes` → `reconcileExecuting` →
 * (EVM: one page of the start-up `reconcileOpenCases`), and the order is
 * load-bearing, not cosmetic:
 *
 * - The sweepers run first because either can change what is due for the
 *   chain steps below them on the very same tick: a case `sweepUndisputed`
 *   upholds becomes something `proposeDue` should see now, not next minute.
 * - `proposeDue` before `executeDue`: a case upheld this tick has to reach the
 *   chain — start its 72h clock — before anything looks for it there. The
 *   on-chain clock starts as early as it honestly can, which is the point of
 *   running the parallel clock at all.
 * - `reconcileExecuting` last, because it is cleanup for a crashed submit and
 *   must never delay a live judgement to do it.
 *
 * ## Why every minute, and not less often
 *
 * The two sweepers act on deadlines measured in days, so a minute of latency is
 * irrelevant to correctness. What a short tick buys is that the queue an
 * operator is looking at agrees with the database they are about to write to:
 * a case that timed out four minutes ago and still shows as workable is a case
 * somebody will spend fifteen minutes deciding before losing the write.
 *
 * - `sweepAdminCancels` after `executeDue`: it reads on-chain records, and
 *   reading them before the execute pass has finished moving them would mirror
 *   a state that is one instant out of date.
 * - `requestCancelsForClosedCases` just before it, so a closed case whose cancel
 *   request was lost is marked and watched on the same tick.
 *
 * ## Why the chain steps live here and not in their own job
 *
 * They are strictly ordered against the two sweepers — a case upheld by
 * `sweepUndisputed` must reach the chain on the same tick — and they have no
 * cadence of their own: both are one-shot per row, driven by a column. A second
 * `@Cron` class would need its own copy of the try/catch discipline above and
 * would double the per-minute round-trips to say the same thing. The design
 * spec calls this `SlashExecutionJob`; the difference is a file boundary and
 * the reason to keep it here is that these steps have to agree about
 * order.
 */
/** One page of old open EVM cases the start-up pass re-derives per tick (review N-3, R2-5). */
const OPEN_EVM_CASES_PAGE = 200;

/** How many later ticks a case whose re-read failed is retried on (review R2-5). */
const OPEN_EVM_CASE_RETRIES = 5;

/** How many open EVM cases past their door one tick follows (review R2-2). */
const OPEN_EVM_CASES_PER_TICK = 100;

/**
 * Review R3-3: how long one tick may hold the overlap guard. A tick still
 * running after this is taken as hung (an RPC or database call with no
 * timeout): a human is paged and the next tick runs, so one stalled call
 * cannot stop every sweep until undisputed records lapse past their grace.
 */
// Review R4-2: above CHAIN_CLAIM_STALE_MS (10 min), so a slow tick is not taken
// over while its own executor claim still counts as live.
export const SLASH_TICK_MAX_MS = 15 * 60_000;

/** Review R3-3: the page for a hung lifecycle tick. */
export const SLASH_TICK_HUNG_ALERT = 'slash_lifecycle_tick_hung';

@Injectable()
export class SlashLifecycleJob {
  private readonly logger = new Logger(SlashLifecycleJob.name);

  constructor(
    private readonly proposals: SlashProposalService,
    private readonly execution: SlashExecutionService,
    private readonly arbitration: ArbitrationService,
    @Optional() private readonly rulings: SlashChainRulingService | null = null,
    @Optional() @Inject(ALERT_PORT) private readonly alerts: AlertPort | null = null,
  ) {}

  /** Review N-3 / R2-5: the start-up pass over old open EVM cases has read its last page. */
  private openEvmCasesReconciled = false;
  /** Where that pass resumes on the next tick. */
  private openEvmCursor: { proposedAt: Date; id: string } | null = null;
  /** Cases whose re-read failed, and how many retries each has had. */
  private readonly openEvmRetries = new Map<
    string,
    { row: { organizationId: string; id: string }; attempts: number }
  >();
  /**
   * Review R2-5: `@nestjs/schedule` does not stop a `@Cron` handler from
   * starting while its previous run is still going. A tick slower than a
   * minute (a long chain read) would run every step twice beside itself, so
   * a tick that finds the previous one still running does nothing — unless
   * that one has run longer than {@link SLASH_TICK_MAX_MS} (review R3-3): it
   * is then paged as hung and the guard is taken over, so one stalled call
   * never wedges the scheduler. `null` when no tick runs; the start time
   * also names the holder, so a hung tick settling late frees nothing.
   */
  private tickStartedAt: number | null = null;

  @Cron(CronExpression.EVERY_MINUTE)
  async handleTick(): Promise<void> {
    const now = Date.now();
    if (this.tickStartedAt !== null) {
      const runningMs = now - this.tickStartedAt;
      if (runningMs <= SLASH_TICK_MAX_MS) {
        this.logger.warn(
          'The previous slash lifecycle tick is still running; this one is skipped.',
        );
        return;
      }
      await this.pageHungTick(this.tickStartedAt, runningMs);
    }
    const startedAt = now;
    this.tickStartedAt = startedAt;
    try {
      await this.runTick();
    } finally {
      if (this.tickStartedAt === startedAt) this.tickStartedAt = null;
    }
  }

  private async pageHungTick(startedAt: number, runningMs: number): Promise<void> {
    const since = new Date(startedAt).toISOString();
    this.logger.error(
      `CRITICAL: a slash lifecycle tick started at ${since} has run ${Math.round(runningMs / 1000)}s ` +
        'and looks hung; the next tick runs beside it',
    );
    try {
      await this.alerts?.emit({
        severity: AlertSeverity.CRITICAL,
        name: SLASH_TICK_HUNG_ALERT,
        summary:
          `A slash lifecycle tick started at ${since} has not finished after ` +
          `${Math.round(runningMs / 60_000)} minutes; a call in it is likely stuck with no ` +
          'timeout. Later ticks run beside it; the stuck call needs a look',
        details: { startedAt: since, runningMs },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: since,
      });
    } catch (error) {
      this.logger.error(
        'The hung slash lifecycle tick could not be paged',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async runTick(): Promise<void> {
    await this.sweepUndisputed();
    // Review R2-2: open EVM cases left open until their records settled.
    await this.followOpenEvmCasesPastDoor();
    await this.sweepPlatformMisses();
    // Before `executeDue`, so a case upheld by the sweep above reaches the
    // chain on the same tick that decided it. The on-chain 72h starts as early
    // as it honestly can, which is the whole point of the parallel clock.
    await this.proposeDue();
    await this.executeDue();
    // Before the admin-cancel sweep, which only watches cases this has marked.
    await this.requestCancelsForClosedCases();
    // After `executeDue` and before the reconcile: a case whose admin cancel
    // landed this tick should have its mirror caught up before anything reasons
    // about parked rows, and running it earlier would have it read records the
    // execute pass is about to move.
    await this.sweepAdminCancels();
    // D-19: disputed records nobody ruled on within 30 days.
    await this.sweepUnresolvedDisputes();
    // Cleanup for a crashed submit, and it must never delay a live judgement
    // to do it.
    await this.reconcileExecuting();
    // Review R2-5: last, one page per tick, so the first tick's sweeps never
    // wait behind it.
    await this.reconcileOpenEvmCases();
  }

  /**
   * Once per scheduler process (review N-3): EVM cases still open from the
   * in-app objection era are re-derived from their on-chain records, so each
   * reaches a live or terminal state. Review R2-5: one page per tick, resumed
   * from a cursor until a page comes back empty (a failed page is read again
   * from the same cursor); a case whose re-read failed is retried on each of
   * the next {@link OPEN_EVM_CASE_RETRIES} ticks, then left with an error.
   */
  private async reconcileOpenEvmCases(): Promise<void> {
    if (!this.rulings) return;
    try {
      let moved = 0;
      if (!this.openEvmCasesReconciled) {
        const page = await this.rulings.reconcileOpenCases(OPEN_EVM_CASES_PAGE, this.openEvmCursor);
        moved += page.moved;
        for (const row of page.failed) {
          this.openEvmRetries.set(row.id, { row, attempts: 0 });
        }
        this.openEvmCursor = page.next;
        this.openEvmCasesReconciled = page.next === null;
      } else if (this.openEvmRetries.size > 0) {
        const entries = [...this.openEvmRetries.values()];
        const retried = await this.rulings.reconcileCases(entries.map((entry) => entry.row));
        moved += retried.moved;
        const stillFailing = new Set(retried.failed.map((row) => row.id));
        for (const entry of entries) {
          if (!stillFailing.has(entry.row.id)) {
            this.openEvmRetries.delete(entry.row.id);
            continue;
          }
          entry.attempts += 1;
          if (entry.attempts >= OPEN_EVM_CASE_RETRIES) {
            this.openEvmRetries.delete(entry.row.id);
            this.logger.error(
              `Open EVM slash case ${entry.row.id} could not be re-derived from its records ` +
                `after ${entry.attempts} retries; it is left for the next scheduler start.`,
            );
          }
        }
      }
      if (moved > 0) {
        this.logger.warn(`${moved} open EVM slash case(s) re-derived from their on-chain records.`);
      }
    } catch (error) {
      this.logger.error(
        `Open EVM case reconciliation aborted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Review R2-2: an open EVM case a record of which stands pending is upheld
   * for the executor only once every undisputed record is past its door by
   * the settle margin, and no chain event comes back for it then; this
   * follows such cases' mirrored records again. No chain read.
   */
  private async followOpenEvmCasesPastDoor(): Promise<void> {
    if (!this.rulings) return;
    try {
      const moved = await this.rulings.followOpenCasesPastDoor(new Date(), OPEN_EVM_CASES_PER_TICK);
      if (moved > 0) {
        this.logger.log(`${moved} open EVM slash case(s) followed their records past the door.`);
      }
    } catch (error) {
      this.logger.error(
        `Following open EVM cases aborted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async sweepUndisputed(): Promise<void> {
    try {
      await this.proposals.sweepUndisputed();
    } catch (error) {
      this.logger.error(
        `Undisputed sweep aborted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async sweepPlatformMisses(): Promise<void> {
    try {
      const overturned = await this.proposals.sweepPlatformMisses();
      if (overturned.length === 0) return;

      // `warn`, not `log`. Every row is a case we were resourced to work and
      // did not. The platform-miss rule puts this deadline on us precisely so
      // that missing it is visible rather than absorbed, and a log line at
      // `info` is absorbed.
      this.logger.warn(
        `${overturned.length} case(s) auto-overturned because we missed our own deadline.`,
      );

      // The chain does not know we missed a deadline. Until it is told the
      // reservation stands and `execute_slash` stays open to anybody once
      // `executable_at` passes — which, on a case the platform itself failed to
      // work, is the worst possible moment for a stranger to be able to take a
      // provider's stake.
      //
      // This only *records* the request: `cancel_slash` is signed
      // by `Config.admin`, and {@link sweepAdminCancels} below is what carries
      // it through — or expires the record itself once its seven-day grace has
      // run, so a request nobody signs still releases the provider's capital.
      //
      // Guarded per row for the reason the steps are guarded separately: one
      // unreadable case must not hold every other provider's released capital.
      for (const row of overturned) {
        try {
          await this.execution.requestAdminCancel(row.organizationId, row.id, 'AUTO_PLATFORM_MISS');
        } catch (error) {
          this.logger.error(
            `requesting the chain cancellation for ${row.id} failed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Platform-miss sweep aborted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Closed cases whose on-chain record nobody has asked to cancel.
   *
   * A suspension or an overturn asks once, after its transaction commits, and
   * that request can be lost — or the record can land after the case was
   * closed. Either way the row is `CANCELLED` / `OVERTURNED` with a `PENDING`
   * mirror that no sweep selects, the stake stays reserved, and the record is
   * anyone's to execute once its timelock passes. This asks again; the
   * admin-cancel sweep below takes it from there.
   */
  private async requestCancelsForClosedCases(): Promise<void> {
    try {
      const requested = await this.execution.requestCancelsForClosedCases();
      if (requested > 0) {
        // `warn`: every row is a cancel request that was lost or raced, and
        // each one still needs the settlement admin's signature before the
        // record's timelock passes.
        this.logger.warn(
          `${requested} closed case(s) still had a pending on-chain record; the admin cancel ` +
            `has now been requested for each.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Closed-case cancel repair aborted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The cases waiting on the settlement admin's `cancel_slash`.
   *
   * Two ends, and only one of them needs a human. Either the admin signed and
   * the mirror catches up, or nobody did and the record's seven-day grace has
   * run, at which point the permissionless `expire_slash` releases the
   * reservation without anybody's permission. `waiting` is the healthy middle,
   * logged only when something else moved so a quiet queue stays quiet.
   */
  private async sweepAdminCancels(): Promise<void> {
    try {
      const { mirrored, expired, waiting } = await this.execution.sweepAdminCancels();
      if (mirrored > 0 || expired > 0) {
        // `warn` on `expired`: a record reaped by this platform is one the
        // settlement admin never got to inside seven days, which is a process
        // failure even though the provider is made whole by it.
        this.logger.warn(
          `Admin-cancel sweep: ${mirrored} mirrored, ${expired} expired, ${waiting} still waiting.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Admin-cancel sweep aborted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async sweepUnresolvedDisputes(): Promise<void> {
    try {
      const { expired } = await this.execution.sweepUnresolvedDisputes();
      if (expired > 0) {
        // `warn`: a dispute nobody ruled on is an arbiter who did not act.
        this.logger.warn(`${expired} on-chain dispute(s) went unruled for 30 days and expired.`);
      }
    } catch (error) {
      this.logger.error(
        `Unresolved-dispute sweep aborted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async proposeDue(): Promise<void> {
    try {
      const { proposed, refused, failed } = await this.execution.proposeDue();
      if (proposed > 0 || refused > 0 || failed > 0) {
        this.logger.log(
          `Chain proposal pass: ${proposed} proposed, ${refused} refused, ${failed} failed.`,
        );
      }
    } catch (error) {
      // Includes the "no executor configured" case, which is the normal state
      // of a deployment with no settlement program id. Logged at `debug` there
      // would hide a real outage; logged at `error` here it is noisy on an
      // unconfigured environment — so the service throws a message that names
      // the configuration, and this line carries it verbatim.
      this.logger.error(
        `Chain proposal pass aborted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async executeDue(): Promise<void> {
    try {
      const { executed, voided, failed } = await this.execution.executeDue();
      if (executed > 0 || voided > 0 || failed > 0) {
        this.logger.log(
          `Slash execution pass: ${executed} executed, ${voided} voided, ${failed} failed.`,
        );
      }
    } catch (error) {
      // Includes the "no executor configured" case, which is the normal state
      // of a deployment with no settlement program id. Logged at `debug` there
      // would hide a real outage; logged at `error` here it is noisy on an
      // unconfigured environment — so the service throws a message that names
      // the configuration, and this line carries it verbatim.
      this.logger.error(
        `Slash execution pass aborted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Cleanup for a submit that crashed mid-flight, plus a park an earlier
   * version left behind. `reconcileExecuting`'s three counters, read against
   * its current body (`slash-execution.service.ts`):
   *
   * - `recovered`: the row is now terminally `EXECUTED` with the ledger
   *   credited. Two different starting shapes land here — an `EXECUTING` row
   *   whose transaction turns out to have landed despite the process that
   *   sent it dying before it could record that (the lost-CAS recovery), and
   *   a park (`chain_status='EXECUTED'`, `executed_at IS NULL`) that this pass
   *   finally completes. Either way the provider has already been charged on
   *   chain; this is bookkeeping catching up to money that already moved.
   * - `returned`: the on-chain record shows no execution (`PENDING` or
   *   absent). The judgement is still alive, so the row goes back to `UPHELD`
   *   with its claim released for the next `executeDue` to pick up.
   * - `voided`: the on-chain record reads `CANCELLED` — a verifier withdrew
   *   the judgement, or it was reaped after its grace ran out. The reservation
   *   is released and the case can never execute.
   */
  private async reconcileExecuting(): Promise<void> {
    try {
      const { recovered, returned, voided } = await this.execution.reconcileExecuting();
      if (recovered > 0 || returned > 0 || voided > 0) {
        // `warn`: every row here is a case whose submitting process died
        // mid-transaction, or a park nothing else reconciles. Recoverable, and
        // worth knowing how often.
        this.logger.warn(
          `Execution reconcile pass: ${recovered} confirmed executed, ${returned} requeued, ` +
            `${voided} voided.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Execution reconcile pass aborted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
