import {
  ConfidenceInterval,
  effectiveThreshold,
  observedRate,
  penaltyFor,
  toleranceFor,
  wilsonInterval,
} from './sla-statistics';

/**
 * The SLA window as a decision, separated from the row it is stored in.
 *
 * Everything here is pure. The service reads a row, calls these, and writes
 * what comes back — which is what makes the boundary check ("position at the window's
 * edges: opening, middle, just under the threshold, just over") a unit test
 * over a function rather than a fixture-heavy integration test that can only
 * reach the boundaries by accident.
 *
 * ## Why this replaces a fold
 *
 * Originally, `ProviderSlaWindowsService` computed a "window" as a rolling
 * UTC calendar day over `payment_intents`, with no table behind it. Three
 * things were wrong with that, and all three are fixed by a row:
 *
 * 1. **A calendar day is a boundary the traffic did not choose.** At $0.001 a
 *    day holds ~80 quality verdicts and can never be judged; at $1.00 it holds
 *    thousands and is judged far more tightly than the binding next to it. The
 *    window closes on {@link SlaWindowSnapshot.minVerifiedCalls} *or* age, so
 *    every window is judged at comparable statistical strength.
 * 2. **A fold cannot freeze a declaration.** A change to `slaFailureRate` must
 *    take effect *at the next window boundary, never mid-window, and recorded on the row so a
 *    dispute is judged against the declared rate as it was*. Re-reading the
 *    binding at query time judges every past day against today's number.
 * 3. **A fold counted `verificationVerdict IS NOT NULL` as "verified".** That
 *    swept in `SKIPPED` — a call nobody checked — and `MISAPPLIED` and
 *    `DEGRADED`, which the verdict vocabulary states are *not the provider's
 *    fault*. Inflating the denominator with calls that carry no quality
 *    observation understates the failure rate, in the provider's favour, by an
 *    amount that varies with the sample rate. {@link countsTowardWindow} is the
 *    replacement rule and it is derived from `VERDICT_CONSEQUENCE`, not
 *    restated: a verdict counts when it moves the **quality** metric, which is
 *    exactly `PASS` and `FAIL`.
 *
 * ## No division by the sample rate
 *
 * An earlier formulation was `estimated_bad = excess_rate × window_calls /
 * sample_rate`. The `/ sample_rate` term is wrong: `observed_rate` is already an
 * estimate of the population rate, and dividing again double-counts it. Nothing
 * in this file divides by a sample rate.
 */

/** `sla_windows.status`. */
export enum SlaWindowStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
}

/**
 * `sla_windows.outcome` — the three ways a window ends.
 *
 * `INSUFFICIENT_SAMPLE` is a **visible** outcome rather than a silent
 * non-event: the provider has
 * to watch thin windows *not* convict them, repeatedly, on ordinary days. That
 * is how the gate becomes believable before the day it matters.
 */
export enum SlaWindowOutcome {
  WITHIN_SLA = 'WITHIN_SLA',
  INSUFFICIENT_SAMPLE = 'INSUFFICIENT_SAMPLE',
  BREACH_PROPOSED = 'BREACH_PROPOSED',
}

/**
 * How far into trouble an in-flight window is.
 *
 * Monotonic and ordered — {@link decideWarning} never steps back down, so a
 * window that has already told a provider it is projected to breach does not
 * later tell them it is merely approaching their threshold.
 */
export enum SlaWarningLevel {
  /** Observed rate has crossed a fraction of the declared one. Actionable. */
  WARNING = 'WARNING',
  /** Projected to breach at close, and the observation is already strong
   * enough to say so with confidence. */
  CRITICAL = 'CRITICAL',
}

const WARNING_ORDER: Readonly<Record<SlaWarningLevel, number>> = Object.freeze({
  [SlaWarningLevel.WARNING]: 1,
  [SlaWarningLevel.CRITICAL]: 2,
});

/**
 * What a provider is told about an in-flight window, in the live SLA screen's vocabulary.
 *
 * `PROJECTED_BREACH` outranks `BELOW_SAMPLE_GATE` deliberately. The screen lists
 * *"not yet slashable"* and *"slashable, projected breach"* as separate states,
 * which reads as though a thin window cannot be projected to breach — but a
 * provider whose first 100 verdicts are 30% failures needs to see that *now*,
 * not in five days when the gate is finally reached. Whether the window is
 * slashable is carried separately, on {@link SlaWindowPosition.slashable}, so
 * the screen can still say both things.
 */
export enum SlaPositionState {
  BELOW_SAMPLE_GATE = 'BELOW_SAMPLE_GATE',
  WITHIN_SLA = 'WITHIN_SLA',
  PROJECTED_BREACH = 'PROJECTED_BREACH',
}

/**
 * The frozen half of a window row — everything decided when it opened.
 *
 * Passed in rather than read from constants so that {@link closeOutcomeFor} and
 * friends judge a window by the rules it was opened under. A window that opened
 * under a 400-call gate is judged against 400 forever, whatever the constant
 * says today.
 */
export interface SlaWindowSnapshot {
  readonly declaredFailureRate: number;
  readonly minVerifiedCalls: number;
  readonly zScore: number;
  readonly maxAgeMs: number;
  readonly warningRatio: number;
  readonly warningMinSampleFraction: number;
  readonly penaltyMultiplier: number;
}

/** The moving half — the counters. */
export interface SlaWindowCounters {
  readonly totalCalls: number;
  readonly verifiedCalls: number;
  readonly failedCalls: number;
  /** Sum of `price_amount` over every counted call, minor units. */
  readonly totalCallAmount: bigint;
}

/**
 * The live position: what the live SLA screen renders — *how much of the error
 * budget has been used, how much is left, and whether the current rate will
 * breach it*.
 */
export interface SlaWindowPosition {
  readonly state: SlaPositionState;
  /** Has the window reached the sample gate? Below it no penalty is possible. */
  readonly slashable: boolean;

  readonly verifiedCalls: number;
  readonly failedCalls: number;
  readonly totalCalls: number;
  /** `failedCalls / verifiedCalls`, or `null` at zero. Never a bare `0%`. */
  readonly observedFailureRate: number | null;
  readonly confidenceInterval: ConfidenceInterval | null;

  /** The sample size the window is expected to have when it closes. */
  readonly projectedSampleAtClose: number;
  /** The threshold that will apply at that size — what the screen labels
   * "effective threshold". */
  readonly effectiveThresholdAtClose: number;
  readonly toleranceAtClose: number;

  // ── The error budget ────────────────────────────────────────────────────
  /** Failures the window can absorb in total, at the projected close size. */
  readonly errorBudgetCalls: number;
  readonly errorBudgetUsedCalls: number;
  readonly errorBudgetRemainingCalls: number;
  /** `used / budget`, `null` when the budget is zero (a 0% declaration).
   * Can exceed 1 — a window already over budget is the case that matters. */
  readonly errorBudgetUsedFraction: number | null;

  // ── The projection ──────────────────────────────────────────────────────
  /** Today's rate, held to close. */
  readonly projectedFailureRate: number | null;
  readonly projectedFailedCalls: number | null;
  /** Would that projection breach? */
  readonly projectedBreach: boolean;
  /**
   * Is the observation *already* strong enough to say the true rate exceeds the
   * declaration — the one-sided 99% lower bound above `declaredFailureRate`?
   *
   * This is what separates "you are having a bad morning" from "you have a
   * problem", and it is the second condition on a `CRITICAL` warning.
   */
  readonly confidentlyAboveDeclared: boolean;

  readonly declaredFailureRate: number;
  readonly minVerifiedCalls: number;
}

/**
 * Does this verdict belong in the window's denominator?
 *
 * Takes the two booleans off `VERDICT_CONSEQUENCE` rather than the status, so
 * this module does not import the verification domain and — more importantly —
 * so the rule cannot drift from the vocabulary. A verdict counts exactly when
 * it moves the **quality** metric: `PASS` and `FAIL`, and nothing else. An
 * eighth status added later is included or excluded by its own consequence row,
 * with no edit here.
 */
export function countsTowardWindow(metric: string | null): boolean {
  return metric === 'quality';
}

/** The live position of an in-flight (or just-closed) window. */
export function positionFor(
  snapshot: SlaWindowSnapshot,
  counters: SlaWindowCounters,
): SlaWindowPosition {
  const { verifiedCalls, failedCalls, totalCalls } = counters;
  const { declaredFailureRate: declared, minVerifiedCalls, zScore } = snapshot;

  const observed = observedRate(failedCalls, verifiedCalls);
  const interval = wilsonInterval(failedCalls, verifiedCalls, zScore);

  // The window closes at the gate, so a window still short of it will reach it;
  // one already past it (age close, or a burst that overshot) closes where it
  // stands. `max` is what makes the budget shown at hour 4 the budget the
  // provider will actually be judged against.
  const projectedSampleAtClose = Math.max(verifiedCalls, minVerifiedCalls);
  const toleranceAtClose = toleranceFor(declared, projectedSampleAtClose, zScore) ?? 0;
  const thresholdAtClose = effectiveThreshold(declared, projectedSampleAtClose, zScore) ?? declared;

  const errorBudgetCalls = Math.floor(thresholdAtClose * projectedSampleAtClose);
  const errorBudgetRemainingCalls = Math.max(0, errorBudgetCalls - failedCalls);

  const projectedBreach = observed !== null && observed > thresholdAtClose;
  const confidentlyAboveDeclared = interval !== null && interval.lower > declared;
  const slashable = verifiedCalls >= minVerifiedCalls;

  const state = projectedBreach
    ? SlaPositionState.PROJECTED_BREACH
    : slashable
      ? SlaPositionState.WITHIN_SLA
      : SlaPositionState.BELOW_SAMPLE_GATE;

  return {
    state,
    slashable,
    verifiedCalls,
    failedCalls,
    totalCalls,
    observedFailureRate: observed,
    confidenceInterval: interval,
    projectedSampleAtClose,
    effectiveThresholdAtClose: thresholdAtClose,
    toleranceAtClose,
    errorBudgetCalls,
    errorBudgetUsedCalls: failedCalls,
    errorBudgetRemainingCalls,
    errorBudgetUsedFraction: errorBudgetCalls === 0 ? null : failedCalls / errorBudgetCalls,
    projectedFailureRate: observed,
    projectedFailedCalls: observed === null ? null : Math.round(observed * projectedSampleAtClose),
    projectedBreach,
    confidentlyAboveDeclared,
    declaredFailureRate: declared,
    minVerifiedCalls,
  };
}

/**
 * Which warning level an in-flight window has reached, or `null` for none.
 *
 * Two levels, because there are two different triggers and both are right for
 * different moments:
 *
 * - **The notification trigger** fires when *"observed rate crosses a configured
 *   fraction of declared"*. Early, cheap, and the version a provider can still
 *   do something about — this is {@link SlaWarningLevel.WARNING}.
 * - **The live SLA screen's state list** puts the warning at *"slashable, projected breach"*.
 *   Later, but it is the one that means money — this is
 *   {@link SlaWarningLevel.CRITICAL}.
 *
 * Firing only the first floods a thin window with noise; firing only the second
 * is silent through the half of the window where a fix is still cheap.
 *
 * `alreadyEmitted` makes the escalation monotonic: passing the level the row
 * already carries returns `null` unless a strictly higher one is now due, so
 * the caller can invoke this on every posted call without deduplicating.
 */
export function decideWarning(
  snapshot: SlaWindowSnapshot,
  position: SlaWindowPosition,
  alreadyEmitted: SlaWarningLevel | null,
): SlaWarningLevel | null {
  // The sample floor gates BOTH levels, not just the cheap one.
  //
  // It is tempting to let `CRITICAL` through unfloored on the grounds that it
  // already carries a confidence test — but the confidence test passes at n = 1.
  // A window whose very first verdict is a `FAIL` has an observed rate of 100%
  // and a Wilson 99% lower bound of 13%, which is genuinely above a 5%
  // declaration and genuinely means nothing. Unfloored, every binding would be
  // told it is projected to breach on its first bad call — the exact false
  // positive `SLA_WARNING_MIN_SAMPLE_FRACTION` exists to prevent, arriving
  // through the louder of the two channels.
  //
  // This is the same argument `MIN_VERIFIED_CALLS` makes about penalties, one
  // level down. A statistical bound is a statement about a sample; it is not a
  // substitute for having one.
  const minSample = snapshot.minVerifiedCalls * snapshot.warningMinSampleFraction;
  if (position.verifiedCalls < minSample) return null;

  const emitted = alreadyEmitted === null ? 0 : WARNING_ORDER[alreadyEmitted];

  // CRITICAL first — a window can qualify for both in one call, and the
  // stronger statement is the one worth a provider's attention.
  if (position.projectedBreach && position.confidentlyAboveDeclared) {
    return emitted < WARNING_ORDER[SlaWarningLevel.CRITICAL] ? SlaWarningLevel.CRITICAL : null;
  }

  const crossedBand =
    position.observedFailureRate !== null &&
    position.observedFailureRate >= snapshot.declaredFailureRate * snapshot.warningRatio;

  if (crossedBand) {
    return emitted < WARNING_ORDER[SlaWarningLevel.WARNING] ? SlaWarningLevel.WARNING : null;
  }

  return null;
}

/** Should this window close now? */
export function shouldClose(
  snapshot: SlaWindowSnapshot,
  counters: SlaWindowCounters,
  openedAt: Date,
  now: number,
): boolean {
  if (counters.verifiedCalls >= snapshot.minVerifiedCalls) return true;
  return now - openedAt.getTime() >= snapshot.maxAgeMs;
}

/**
 * The outcome a closing window earns.
 *
 * The gate is checked **first** and it is absolute: below
 * `minVerifiedCalls` there is no breach to find, however bad the observation
 * looks. The correct response to a suspicious thin window is to raise that binding's
 * sampling and wait, not to slash on noise.
 */
export function closeOutcomeFor(
  snapshot: SlaWindowSnapshot,
  counters: SlaWindowCounters,
): SlaWindowOutcome {
  if (counters.verifiedCalls < snapshot.minVerifiedCalls) {
    return SlaWindowOutcome.INSUFFICIENT_SAMPLE;
  }

  const observed = observedRate(counters.failedCalls, counters.verifiedCalls);
  const threshold = effectiveThreshold(
    snapshot.declaredFailureRate,
    counters.verifiedCalls,
    snapshot.zScore,
  );

  if (observed === null || threshold === null || observed <= threshold) {
    return SlaWindowOutcome.WITHIN_SLA;
  }

  return SlaWindowOutcome.BREACH_PROPOSED;
}

/** One line of {@link StrikeArithmetic.computation}. */
export interface StrikeComputationStep {
  readonly label: string;
  readonly expression: string;
  readonly value: string;
}

/**
 * Everything a strike record has to carry so the argument can be rebuilt from
 * the row alone, without re-reading a constant, a binding or a policy file.
 */
export interface StrikeArithmetic {
  readonly totalCalls: number;
  readonly verifiedCalls: number;
  readonly failedCalls: number;
  readonly observedRate: number;

  readonly declaredFailureRate: number;
  readonly minVerifiedCalls: number;
  readonly zScore: number;
  readonly tolerance: number;
  readonly effectiveThreshold: number;

  readonly excessRate: number;
  readonly estimatedBadCalls: number;
  readonly averagePriceAmount: bigint;
  readonly penaltyMultiplier: number;
  readonly penaltyAmount: bigint;

  /** The same numbers as an ordered, human-readable derivation. This is the
   * "show the arithmetic" the use-case doc says every evidence pack lacks. */
  readonly computation: readonly StrikeComputationStep[];
}

/**
 * The strike, computed.
 *
 * Only ever called for a window whose outcome is
 * {@link SlaWindowOutcome.BREACH_PROPOSED} — the caller checks, because a
 * strike for a window that did not breach is not a smaller mistake than a wrong
 * number in one.
 *
 * **No cap is applied here.** What this records is the **formula result**; the
 * slash-proposal flow is what turns it into a proposal. The caps that exist
 * are on chain: `proposeSlash` refuses a penalty above the attested
 * `penaltyAmount`, and the provider's rolling window admits at most
 * `slashCapBps` of the stake at risk (`prorata-slash.ts`). Nothing — here, in
 * the proposal flow or on chain — applies a per-window
 * `min(formula, max($5, 100 × price))` cap; that figure is a design note, not
 * an enforced limit.
 *
 * Likewise `MIN_SLASH_PENALTY` and its carry-forward: a strike below the
 * de-minimis floor is still a strike and is still recorded here. Deciding that
 * it is not worth adjudicating yet is a property of the proposal, not of the
 * observation.
 */
export function strikeArithmeticFor(
  snapshot: SlaWindowSnapshot,
  counters: SlaWindowCounters,
): StrikeArithmetic {
  const { totalCalls, verifiedCalls, failedCalls, totalCallAmount } = counters;
  const { declaredFailureRate: declared, zScore, penaltyMultiplier } = snapshot;

  const observed = observedRate(failedCalls, verifiedCalls) ?? 0;
  const tolerance = toleranceFor(declared, verifiedCalls, zScore) ?? 0;
  const threshold = declared + tolerance;

  // The excess is measured against the DECLARATION, not against the effective
  // threshold. The tolerance decides *whether* a window breached; it is not a
  // free allowance the penalty then starts counting from. Charging from the
  // threshold would mean a provider who declared 5% and ran at 15% paid as
  // though they had promised 7.8%.
  const excessRate = Math.max(0, observed - declared);
  const estimatedBadCalls = excessRate * totalCalls;
  const averagePriceAmount = totalCalls > 0 ? totalCallAmount / BigInt(totalCalls) : 0n;
  const penaltyAmount = penaltyFor(totalCallAmount, excessRate, penaltyMultiplier);

  const pct = (value: number): string => `${(value * 100).toFixed(4)}%`;

  return {
    totalCalls,
    verifiedCalls,
    failedCalls,
    observedRate: observed,
    declaredFailureRate: declared,
    minVerifiedCalls: snapshot.minVerifiedCalls,
    zScore,
    tolerance,
    effectiveThreshold: threshold,
    excessRate,
    estimatedBadCalls,
    averagePriceAmount,
    penaltyMultiplier,
    penaltyAmount,
    computation: Object.freeze([
      {
        label: 'observed_rate',
        expression: `${failedCalls} failed / ${verifiedCalls} verified`,
        value: pct(observed),
      },
      {
        label: 'tolerance',
        expression: `${zScore} × sqrt(${declared} × ${1 - declared} / ${verifiedCalls})`,
        value: pct(tolerance),
      },
      {
        label: 'effective_threshold',
        expression: `${pct(declared)} declared + ${pct(tolerance)} tolerance`,
        value: pct(threshold),
      },
      {
        label: 'sample_gate',
        expression: `${verifiedCalls} verified >= ${snapshot.minVerifiedCalls} required`,
        value: String(verifiedCalls >= snapshot.minVerifiedCalls),
      },
      {
        label: 'excess_rate',
        expression: `${pct(observed)} observed − ${pct(declared)} declared`,
        value: pct(excessRate),
      },
      {
        label: 'estimated_bad_calls',
        expression: `${pct(excessRate)} × ${totalCalls} window calls`,
        value: estimatedBadCalls.toFixed(4),
      },
      {
        label: 'average_price',
        expression: `${totalCallAmount} minor units / ${totalCalls} calls`,
        value: averagePriceAmount.toString(),
      },
      {
        label: 'penalty',
        expression:
          `${totalCallAmount} × ${pct(excessRate)} × ${penaltyMultiplier} ` +
          `(= estimated_bad × average_price × multiplier)`,
        value: penaltyAmount.toString(),
      },
    ]),
  };
}
