/**
 * The SLA window write path.
 *
 * `postCall` is the seam `VerificationSettlementService.settle()` calls for
 * every judged call, through the `SlaWindowPoster` port — see
 * `sla-window.module.ts` for why this class lives behind a port rather than
 * being imported directly. Everything here is glue: read a row (or open one),
 * hand its frozen rules and counters to the pure functions in
 * `domain/sla/sla-window.ts`, and write back exactly what they decide. The
 * arithmetic itself is not re-derived here — see that file and
 * `domain/sla/sla-statistics.ts`.
 *
 * Three idempotency guarantees do the real work, and none of them is a
 * read-then-write:
 *
 * 1. `uq_sla_window_calls_intent` — a duplicate `postCall` for the same
 *    `intentId` (BullMQ redelivers at least once) is caught as a no-op before
 *    any counter moves.
 * 2. `uq_sla_windows_open` — two workers racing to open the first window for
 *    a (binding, asset) both attempt the insert; the loser reads the winner's
 *    row instead of failing.
 * 3. `uq_sla_strikes_window` — the backstop under `closeIfOpen`'s
 *    compare-and-swap, in case two passes ever raced past it anyway.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { SlaWindowEntity } from '@database/postgres/entities/sla-window.entity';
import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { SlaStrikeRepository } from '@database/postgres/repositories/sla-strike.repository';
import { SlaWindowCallRepository } from '@database/postgres/repositories/sla-window-call.repository';
import { SlaWindowRepository } from '@database/postgres/repositories/sla-window.repository';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
  NotificationSeverity,
} from '@modules/notification/ports/notification.port';
import {
  SLASH_PROPOSAL_OPENER,
  SlashProposalOpenerPort,
} from '@modules/slash/ports/slash-proposal-opener.port';
import {
  PostSlaWindowCallInput,
  SlaWindowPoster,
} from '@modules/verification/ports/sla-window-poster.port';
import {
  VERDICT_CONSEQUENCE,
  VerdictConsequence,
  VerdictStatus,
  isProviderAtFault,
} from '@modules/verification/domain/verdict';

import { SLA_WINDOW_CONFIG, SlaWindowConfig } from '../constants/sla-window.constants';
import { countersFrom, snapshotFrom } from './sla-window-row.util';
import {
  SlaWarningLevel,
  SlaWindowOutcome,
  SlaWindowPosition,
  SlaWindowStatus,
  StrikeArithmetic,
  closeOutcomeFor,
  countsTowardWindow,
  decideWarning,
  positionFor,
  shouldClose,
  strikeArithmeticFor,
} from '../domain/sla/sla-window';

/** How many overdue windows one sweep pass closes, so a long outage does not
 * turn the first pass afterward into an unbounded transaction. */
const SWEEP_BATCH_SIZE = 500;

const STRIKE_STATUS_RECORDED = 'RECORDED';

@Injectable()
export class SlaWindowService implements SlaWindowPoster {
  private readonly logger = new Logger(SlaWindowService.name);

  constructor(
    private readonly windows: SlaWindowRepository,
    private readonly calls: SlaWindowCallRepository,
    private readonly strikes: SlaStrikeRepository,
    private readonly bindings: ToolBindingRepository,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    @Inject(SLA_WINDOW_CONFIG) private readonly config: SlaWindowConfig,
    // Optional, and null wherever the slash-proposal satellite module is not
    // imported — notably in this service's own unit tests, which construct it
    // directly and must keep passing unchanged. A window still closes, still writes its
    // strike and still warns the provider without a proposal opener; what it
    // does not do is open a case, which is exactly the behaviour that existed
    // before slash proposals.
    @Optional()
    @Inject(SLASH_PROPOSAL_OPENER)
    private readonly proposalOpener: SlashProposalOpenerPort | null = null,
  ) {}

  // ── The write seam ───────────────────────────────────────────────────────

  async postCall(input: PostSlaWindowCallInput): Promise<void> {
    if (!input.bindingId) {
      this.logger.debug(
        `Intent ${input.intentId} has no bindingId; not posting it to an SLA window.`,
      );
      return;
    }

    const window = await this.findOrCreateOpenWindow(
      input.organizationId,
      input.providerId,
      input.bindingId,
      input.toolId,
      input.assetId,
    );

    const metric = metricFor(input.verdictStatus);
    const countedAsQuality = countsTowardWindow(metric);
    const countedAsFailure =
      countedAsQuality &&
      isVerdictStatus(input.verdictStatus) &&
      isProviderAtFault(input.verdictStatus);

    const inserted = await this.insertCall(window, input, countedAsQuality, countedAsFailure);
    if (!inserted) {
      // `uq_sla_window_calls_intent` already has this call. Counters must not
      // move a second time for one intent.
      return;
    }

    const counted = await this.windows.incrementCounters(input.organizationId, window.id, {
      countedAsQuality,
      countedAsFailure,
      priceAmount: input.priceAmount,
    });
    if (counted === 0) {
      // The window closed between `findOrCreateOpenWindow` and here — a
      // concurrent `postCall` (or the sweep) crossed the gate first. The call
      // row stays as the record that it arrived, and the counters stay exactly
      // the set the window was judged on; see
      // `SlaWindowRepository.incrementCounters` for why that is the
      // conservative direction. Nothing left to warn about or close.
      this.logger.debug(
        `Window ${window.id} closed before intent ${input.intentId} could be counted; ` +
          `the call is recorded but not counted.`,
      );
      return;
    }

    const fresh = await this.windows.findOneBy({
      organizationId: input.organizationId,
      id: window.id,
    });
    if (!fresh) {
      throw new Error(`sla window ${window.id} vanished immediately after posting a call`);
    }

    await this.maybeWarn(input.organizationId, fresh);

    const snapshot = snapshotFrom(fresh);
    const counters = countersFrom(fresh);
    if (shouldClose(snapshot, counters, fresh.openedAt, this.config.now())) {
      await this.closeWindow(input.organizationId, fresh);
    }
  }

  // ── The age sweep ────────────────────────────────────────────────────────

  /**
   * Closes every `OPEN` window past its `deadlineAt`, up to
   * {@link SWEEP_BATCH_SIZE} per pass. Plain service method — the `@Cron`
   * wrapper lives in `jobs/sla-window-sweep.job.ts` so this stays callable
   * from a test, or an operator endpoint, with no scheduler in the picture.
   *
   * Returns how many windows this pass actually closed, so the job can log a
   * nonzero pass — which in steady state means every posting worker is
   * already closing its own windows at the sample gate, and only a binding
   * that went quiet mid-window reaches the sweep at all.
   */
  async sweepExpiredWindows(): Promise<number> {
    const now = new Date(this.config.now());
    const due = await this.windows.findDueForSweep(now, SWEEP_BATCH_SIZE);

    let closed = 0;
    for (const row of due) {
      const window = await this.windows.findOneBy({
        organizationId: row.organizationId,
        id: row.id,
      });
      if (!window || window.status !== SlaWindowStatus.OPEN) {
        // A `postCall` on the same binding closed it between the sweep's own
        // read and this one — not an error, just a race this pass lost.
        continue;
      }
      await this.closeWindow(row.organizationId, window);
      closed += 1;
    }
    return closed;
  }

  // ── Opening a window ─────────────────────────────────────────────────────

  private async findOrCreateOpenWindow(
    organizationId: string,
    providerId: string,
    bindingId: string,
    toolId: string,
    assetId: string,
  ): Promise<SlaWindowEntity> {
    // Per (binding, asset): a binding that changed its settlement asset keeps
    // the old asset's window open (the sweep closes it on age) and opens a new
    // one, so totals and any penalty stay in one currency. Closing the old one
    // on the switch instead would let a provider reset a failing sample by
    // flipping assets.
    const existing = await this.windows.findOpenForBinding(organizationId, bindingId, assetId);
    if (existing) {
      return existing;
    }

    const binding = await this.bindings.findOneBy({ organizationId, id: bindingId });
    if (!binding) {
      // `sla_windows.binding_id` has `ON DELETE CASCADE` to `tool_bindings`
      // and a binding is never hard-deleted while it has traffic, so this is
      // an upstream inconsistency (a stale `bindingId` on the intent) rather
      // than an ordinary race — surfaced rather than silently skipped.
      throw new Error(`tool binding ${bindingId} not found while opening an SLA window`);
    }

    const now = new Date(this.config.now());
    const sequence = await this.windows.nextSequence(organizationId, bindingId);

    try {
      const result = await this.windows.insert({
        organizationId,
        providerId,
        bindingId,
        toolId,
        sequence,
        status: SlaWindowStatus.OPEN,
        outcome: null,
        openedAt: now,
        deadlineAt: new Date(now.getTime() + this.config.maxAgeMs),
        closedAt: null,
        declaredFailureRate: binding.slaFailureRate,
        minVerifiedCalls: this.config.minVerifiedCalls,
        zScore: this.config.zScore,
        maxAgeMs: String(this.config.maxAgeMs),
        warningRatio: this.config.warningRatio,
        warningMinSampleFraction: this.config.warningMinSampleFraction,
        penaltyMultiplier: this.config.penaltyMultiplier,
        totalCalls: 0,
        verifiedCalls: 0,
        failedCalls: 0,
        totalCallAmount: '0',
        assetId,
        warningLevel: null,
        warnedAt: null,
        criticalWarnedAt: null,
        samplingEscalationRequested: false,
      });

      const id = result.identifiers[0]?.id as string | undefined;
      if (!id) {
        throw new Error(`sla window insert for binding ${bindingId} returned no id`);
      }

      const created = await this.windows.findOneBy({ organizationId, id });
      if (!created) {
        throw new Error(`sla window ${id} did not persist immediately after insert`);
      }
      return created;
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      // `uq_sla_windows_open`: another worker opened the window first — the
      // ordinary case, not the rare one, since every verification worker
      // settling this binding's traffic races here. Read the winner's row
      // instead of failing.
      this.logger.debug(
        `Lost the race to open an SLA window for binding ${bindingId}; reading the winner's row.`,
      );
      const raced = await this.windows.findOpenForBinding(organizationId, bindingId, assetId);
      if (!raced) {
        // The unique violation says a row exists; if it is gone by the time we
        // re-read, something outside this class's control removed it.
        throw new Error(`sla window race for binding ${bindingId} resolved to no open window`);
      }
      return raced;
    }
  }

  // ── Posting one call ─────────────────────────────────────────────────────

  private async insertCall(
    window: SlaWindowEntity,
    input: PostSlaWindowCallInput,
    countedAsQuality: boolean,
    countedAsFailure: boolean,
  ): Promise<boolean> {
    try {
      await this.calls.insert({
        organizationId: input.organizationId,
        windowId: window.id,
        intentId: input.intentId,
        agentId: input.agentId,
        verdict: input.verdictStatus,
        reasonCode: input.reasonCode,
        countedAsQuality,
        countedAsFailure,
        priceAmount: input.priceAmount,
        assetId: input.assetId,
        postedAt: input.postedAt,
      });
      return true;
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      this.logger.debug(
        `Intent ${input.intentId} was already posted to an SLA window; not posting it twice.`,
      );
      return false;
    }
  }

  // ── Early warning ────────────────────────────────────────────────────────

  private async maybeWarn(organizationId: string, window: SlaWindowEntity): Promise<void> {
    const snapshot = snapshotFrom(window);
    const counters = countersFrom(window);
    const position = positionFor(snapshot, counters);
    const currentLevel = (window.warningLevel as SlaWarningLevel | null) ?? null;
    const newLevel = decideWarning(snapshot, position, currentLevel);
    if (newLevel === null) {
      return;
    }

    const now = new Date(this.config.now());
    const isCritical = newLevel === SlaWarningLevel.CRITICAL;
    const affected = await this.windows.stampWarningIfLower(
      organizationId,
      window.id,
      newLevel,
      now,
      isCritical,
    );
    if (affected === 0) {
      // A concurrent `postCall` already stamped this level (or a higher one)
      // — the `IS DISTINCT FROM` guard is what makes this branch reachable at
      // all, and reaching it means "someone else already told the provider".
      return;
    }

    await this.notifyWarning(organizationId, window, position, newLevel);
  }

  private async notifyWarning(
    organizationId: string,
    window: SlaWindowEntity,
    position: SlaWindowPosition,
    level: SlaWarningLevel,
  ): Promise<void> {
    const [reasonGroups, agentGroups] = await Promise.all([
      this.calls.countFailuresByReasonCode(organizationId, window.id),
      this.calls.countFailuresByAgentId(organizationId, window.id),
    ]);

    const topRule = reasonGroups[0]
      ? `${reasonGroups[0].key} ${reasonGroups[0].count}`
      : 'none yet';
    const topAgent = agentGroups[0]
      ? `${agentGroups[0].key} (${agentGroups[0].count})`
      : 'none yet';
    const callsRemaining = Math.max(0, position.projectedSampleAtClose - position.verifiedCalls);
    const observedPct = formatPct(position.observedFailureRate);
    const declaredPct = formatPct(position.declaredFailureRate);
    const label = windowLabel(window);
    const critical = level === SlaWarningLevel.CRITICAL;

    await this.notifications.notify({
      organizationId,
      event: NotificationEvent.PROVIDER_SLA_WINDOW_WARNING,
      title: critical
        ? `SLA window ${label} is projected to breach`
        : `SLA window ${label} is approaching your declared rate`,
      body:
        `Observed failure rate ${observedPct} against a declared ${declaredPct} ` +
        `(${position.verifiedCalls}/${position.projectedSampleAtClose} verified calls, ` +
        `${callsRemaining} remaining before the window closes). ` +
        `Top failing rule: ${topRule}. Top agent: ${topAgent}.`,
      severity: critical ? NotificationSeverity.CRITICAL : undefined,
      subjectType: 'binding',
      subjectId: window.bindingId,
      dedupeKey: `${window.id}:${level}`,
      payload: {
        windowId: window.id,
        label,
        bindingId: window.bindingId,
        level,
        verifiedCalls: position.verifiedCalls,
        failedCalls: position.failedCalls,
        callsRemaining,
        observedFailureRate: position.observedFailureRate,
        declaredFailureRate: position.declaredFailureRate,
        topFailingRule: reasonGroups[0]?.key ?? null,
        topAgentId: agentGroups[0]?.key ?? null,
      },
    });
  }

  // ── Closing a window ─────────────────────────────────────────────────────

  private async closeWindow(organizationId: string, window: SlaWindowEntity): Promise<void> {
    const snapshot = snapshotFrom(window);
    const counters = countersFrom(window);
    const outcome = closeOutcomeFor(snapshot, counters);
    const now = new Date(this.config.now());

    const affected = await this.windows.closeIfOpen(organizationId, window.id, {
      outcome,
      closedAt: now,
      samplingEscalationRequested: outcome === SlaWindowOutcome.INSUFFICIENT_SAMPLE,
    });
    if (affected === 0) {
      // Lost the close compare-and-swap to a concurrent `postCall`/sweep pass
      // — whoever won already ran (or is running) the branch below.
      this.logger.debug(`Window ${window.id} was already closed by another pass.`);
      return;
    }

    if (outcome !== SlaWindowOutcome.BREACH_PROPOSED) {
      return;
    }

    const arithmetic = strikeArithmeticFor(snapshot, counters);
    const written = await this.writeStrike(organizationId, window, arithmetic, now);
    if (written) {
      await this.notifyBreach(organizationId, window, arithmetic);
      await this.openProposal(organizationId, window.id);
    }
  }

  /**
   * Hand the strike to the slash-proposal lifecycle.
   *
   * Guarded by `written`, so exactly one of the racing closers reaches it — the
   * proposal opener is idempotent on `uq_slash_proposals_strike` as well, but
   * relying on that alone would send every loser through a notification path
   * for a case it did not open.
   *
   * The strike is read back rather than passed down from `writeStrike`, which
   * returns a boolean because its caller only ever needed to know whether it
   * won the race. Re-reading costs one indexed lookup on a path that fires once
   * per window, and changing the return type would have rippled through
   * this service's tests for no behavioural gain.
   *
   * Failures here are logged and swallowed. A window that closed in breach has
   * *already* been recorded and the provider has *already* been told; a
   * proposal that fails to open is a case that does not exist yet, which is
   * recoverable, whereas throwing would unwind a close that is correct and
   * leave the counters to be re-judged.
   */
  private async openProposal(organizationId: string, windowId: string): Promise<void> {
    if (!this.proposalOpener) return;

    try {
      const strike = await this.strikes.findOneBy({ organizationId, windowId });
      if (!strike) return;
      await this.proposalOpener.openFromStrike(strike);
    } catch (error) {
      this.logger.error(
        `Failed to open a slash proposal for window ${windowId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async writeStrike(
    organizationId: string,
    window: SlaWindowEntity,
    arithmetic: StrikeArithmetic,
    now: Date,
  ): Promise<boolean> {
    try {
      await this.strikes.insert({
        organizationId,
        providerId: window.providerId,
        bindingId: window.bindingId,
        toolId: window.toolId,
        windowId: window.id,
        status: STRIKE_STATUS_RECORDED,
        recordedAt: now,
        windowOpenedAt: window.openedAt,
        windowClosedAt: now,
        totalCalls: arithmetic.totalCalls,
        verifiedCalls: arithmetic.verifiedCalls,
        failedCalls: arithmetic.failedCalls,
        observedRate: arithmetic.observedRate,
        declaredFailureRate: window.declaredFailureRate,
        minVerifiedCalls: arithmetic.minVerifiedCalls,
        zScore: arithmetic.zScore,
        tolerance: arithmetic.tolerance,
        effectiveThreshold: arithmetic.effectiveThreshold,
        excessRate: arithmetic.excessRate,
        estimatedBadCalls: arithmetic.estimatedBadCalls,
        averagePriceAmount: arithmetic.averagePriceAmount.toString(),
        penaltyMultiplier: arithmetic.penaltyMultiplier,
        penaltyAmount: arithmetic.penaltyAmount.toString(),
        assetId: window.assetId,
        computation: arithmetic.computation,
      });
      return true;
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // `uq_sla_strikes_window` — the backstop `closeIfOpen`'s CAS is meant to
      // make unreachable. Reaching it anyway is still a no-op, not a second
      // penalty for one finding.
      this.logger.warn(`Window ${window.id} already has a strike; not writing a second one.`);
      return false;
    }
  }

  private async notifyBreach(
    organizationId: string,
    window: SlaWindowEntity,
    arithmetic: StrikeArithmetic,
  ): Promise<void> {
    const label = windowLabel(window);
    await this.notifications.notify({
      organizationId,
      event: NotificationEvent.PROVIDER_SLA_BREACH_PROPOSED,
      title: `SLA window ${label} closed in breach`,
      body:
        `Observed failure rate ${formatPct(arithmetic.observedRate)} exceeded the effective ` +
        `threshold of ${formatPct(arithmetic.effectiveThreshold)} over ${arithmetic.verifiedCalls} ` +
        `verified calls. Estimated penalty ${arithmetic.penaltyAmount.toString()} ${window.assetId} ` +
        `(uncapped formula result — the on-chain caps apply at proposal time).`,
      subjectType: 'binding',
      subjectId: window.bindingId,
      dedupeKey: `${window.id}:breach`,
      payload: {
        windowId: window.id,
        label,
        bindingId: window.bindingId,
        totalCalls: arithmetic.totalCalls,
        verifiedCalls: arithmetic.verifiedCalls,
        failedCalls: arithmetic.failedCalls,
        observedRate: arithmetic.observedRate,
        effectiveThreshold: arithmetic.effectiveThreshold,
        penaltyAmount: arithmetic.penaltyAmount.toString(),
        assetId: window.assetId,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isVerdictStatus(value: string | null): value is VerdictStatus {
  return value !== null && Object.prototype.hasOwnProperty.call(VERDICT_CONSEQUENCE, value);
}

function metricFor(verdictStatus: string | null): VerdictConsequence['metric'] {
  return isVerdictStatus(verdictStatus) ? VERDICT_CONSEQUENCE[verdictStatus].metric : null;
}

function windowLabel(window: SlaWindowEntity): string {
  return `w_${window.sequence}`;
}

function formatPct(rate: number | null): string {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(2)}%`;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { code?: unknown; driverError?: { code?: unknown } };
  return (
    candidate.code === UNIQUE_VIOLATION_CODE ||
    candidate.driverError?.code === UNIQUE_VIOLATION_CODE
  );
}
