/**
 * The numbers an SLA window is judged by.
 *
 * Every one of them is **frozen onto the window row when it opens**, never read
 * live at close. A window that opened under a 400-call gate must still be
 * judged against 400 after someone raises the constant, or the platform would
 * be re-deciding closed history by editing a file — which is the single thing
 * a penalty must never be able to do.
 */

/**
 * Below this many quality-bearing verdicts a window is **not slashable at all**.
 *
 * `MIN_VERIFIED_CALLS = 400` — below this, no slash proposal is issued at all.
 *
 * The gate is not a fairness refinement, it is the thing that makes the
 * mechanism solvent. At n = 80 a provider whose *true* rate is exactly the 5%
 * they declared shows an observed rate above 5% in 37% of windows; slashing on
 * that produces ~37 false proposals per binding per month and a dispute load
 * that no adjudication budget survives.
 */
export const MIN_VERIFIED_CALLS = 400;

/**
 * The two-sided z for a 99% bound, used one-sided here.
 *
 * `tolerance = Z * sqrt(p(1-p)/n)`, and the reference worked example uses
 * 2.58, so the constant is transcribed rather than recomputed from a normal
 * quantile.
 */
export const SLA_Z_SCORE = 2.58;

/**
 * A window closes at {@link MIN_VERIFIED_CALLS} verified calls **or** this age,
 * whichever comes first.
 *
 * Seven days. This is what replaces the rolling UTC calendar day an earlier
 * fold used: a calendar day is a boundary the
 * traffic did not choose, so a $0.001 binding's day held 80 verified calls and
 * was unjudgeable while a $1.00 binding's day held 4,000 and was judged twice
 * as tightly as the provider next to it.
 */
export const SLA_WINDOW_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `penalty = estimated_bad × avg_price × PENALTY_MULTIPLIER`.
 *
 * 2×, so that cheating is −EV even though only a sampled fraction of calls is
 * ever inspected: Stage 1 has already withheld the revenue on the bad calls, so
 * the multiplier is a genuine loss on top rather than a clawback.
 */
export const SLA_PENALTY_MULTIPLIER = 2;

/**
 * The fraction of the declared rate at which the **first** warning fires.
 *
 * **Chosen here.** `provider.sla_window_warning` fires when the observed rate
 * *"crosses a configured fraction of declared"*, and nothing else fixes what
 * the fraction is. 0.8 is the
 * band the platform already uses for the other "you are approaching a limit
 * you set yourself" signal — `STAKE_HEADROOM_WARNING_RATIO`, and the 80% spend
 * band on buyer spend limits — so a provider meets one number in three places instead of
 * three numbers.
 */
export const SLA_WARNING_RATIO = 0.8;

/**
 * How much of the window must have accrued before the first warning may fire.
 *
 * **Chosen here.** The warning must fire *mid-window, early enough to still
 * fix it* — and
 * a quarter of the sample gate is the earliest point at which "middle" is a
 * fair description. Without a floor the rule is unusable rather than merely
 * noisy: the first failed call in a fresh window puts the observed rate at
 * 100%, which crosses 80% of any declared rate, so every binding whose very
 * first verdict is a `FAIL` would be warned that it is about to breach.
 *
 * This is the mirror of {@link MIN_VERIFIED_CALLS} one level down — the same
 * "an observation this thin says nothing" argument, applied to a warning
 * instead of to a penalty, and set lower because being early is the entire
 * point of a warning and the cost of being wrong is a sentence rather than a
 * dollar.
 */
export const SLA_WARNING_MIN_SAMPLE_FRACTION = 0.25;

/** Cron for the age sweep. Windows that close on {@link SLA_WINDOW_MAX_AGE_MS}
 * have, by definition, stopped receiving the calls that would otherwise close
 * them, so nothing but a timer can notice. */
export const SLA_WINDOW_SWEEP_CRON = '*/5 * * * *';

/** DI token for the injected clock + parameters, in the `STAKE_MONITOR_CONFIG` style. */
export const SLA_WINDOW_CONFIG = Symbol('SLA_WINDOW_CONFIG');

export interface SlaWindowConfig {
  readonly minVerifiedCalls: number;
  readonly zScore: number;
  readonly maxAgeMs: number;
  readonly warningRatio: number;
  readonly warningMinSampleFraction: number;
  readonly penaltyMultiplier: number;
  /** Injected, never `Date.now()` inline — a test must be able to stand a
   * window one second past its 7-day deadline instead of waiting a week. */
  readonly now: () => number;
}

export const DEFAULT_SLA_WINDOW_CONFIG: SlaWindowConfig = Object.freeze({
  minVerifiedCalls: MIN_VERIFIED_CALLS,
  zScore: SLA_Z_SCORE,
  maxAgeMs: SLA_WINDOW_MAX_AGE_MS,
  warningRatio: SLA_WARNING_RATIO,
  warningMinSampleFraction: SLA_WARNING_MIN_SAMPLE_FRACTION,
  penaltyMultiplier: SLA_PENALTY_MULTIPLIER,
  now: () => Date.now(),
});
