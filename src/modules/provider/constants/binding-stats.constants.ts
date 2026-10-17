import { ConfigService } from '@nestjs/config';

/**
 * The numbers the observed-stats pipeline (`binding_attempts` →
 * `binding_stats` → `ProviderStats`) is tuned by.
 *
 * Two of them are environment settings because an operator may need to move
 * them during an incident — a shorter window reacts faster to a provider that
 * just broke, a larger minimum sample is the lever when one noisy hour is
 * moving traffic it should not. Both are validated at boot: a window of zero
 * or a minimum sample above the window would silently pin every provider to
 * `NEUTRAL_PRIOR` forever, which is the bug this pipeline exists to end.
 */

/** `BINDING_STATS_WINDOW_SIZE`: how many attempts (and verdicts) per binding the window holds. */
export const BINDING_STATS_WINDOW_SIZE_ENV = 'BINDING_STATS_WINDOW_SIZE';

/** `BINDING_STATS_MIN_SAMPLE`: below this many observations a rate stays unmeasured. */
export const BINDING_STATS_MIN_SAMPLE_ENV = 'BINDING_STATS_MIN_SAMPLE';

/** The last 1,000 attempts — the same order as `EXPLORATION_CALL_THRESHOLD`. */
export const DEFAULT_BINDING_STATS_WINDOW_SIZE = 1000;

/**
 * 50. Below it one failure moves a rate by 2% or more, which is noise next to
 * the 0.25 availability weight; above it a new binding spends its whole
 * exploration share on the prior.
 */
export const DEFAULT_BINDING_STATS_MIN_SAMPLE = 50;

/** Hard upper bound on the window, so a typo cannot make the refresh scan a table's worth per binding. */
export const MAX_BINDING_STATS_WINDOW_SIZE = 100_000;

/**
 * Nothing older than seven days is in a window, however quiet the binding.
 *
 * The window is "the last N", and for a binding that serves a few calls a day
 * the last N can reach back months — a provider who fixed an outage in March
 * would still be routed on it in June. Seven days is the age the SLA window
 * already closes on (`SLA_WINDOW_MAX_AGE_MS`) and the span `ProviderStats`
 * documents for quality.
 */
export const BINDING_STATS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Every five minutes, the cadence of the other scheduler sweeps. The router
 * therefore reacts to a broken provider within five minutes; failover covers
 * the calls in between, one attempt each.
 */
export const BINDING_STATS_REFRESH_CRON = '*/5 * * * *';

/** DI token for {@link BindingStatsConfig}. */
export const BINDING_STATS_CONFIG = Symbol('BINDING_STATS_CONFIG');

export interface BindingStatsConfig {
  readonly windowSize: number;
  readonly minSampleSize: number;
  readonly maxAgeMs: number;
}

export const DEFAULT_BINDING_STATS_CONFIG: BindingStatsConfig = Object.freeze({
  windowSize: DEFAULT_BINDING_STATS_WINDOW_SIZE,
  minSampleSize: DEFAULT_BINDING_STATS_MIN_SAMPLE,
  maxAgeMs: BINDING_STATS_MAX_AGE_MS,
});

/**
 * Reads and validates the two settings. Throws — refusing to boot — on a value
 * that is not a whole number in range, rather than falling back: an operator
 * who set the variable meant something, and silently running on the default
 * would hide that it was not applied.
 */
export function loadBindingStatsConfig(config: ConfigService): BindingStatsConfig {
  const windowSize = readWholeNumber(
    config.get<string>(BINDING_STATS_WINDOW_SIZE_ENV),
    DEFAULT_BINDING_STATS_WINDOW_SIZE,
    BINDING_STATS_WINDOW_SIZE_ENV,
    1,
    MAX_BINDING_STATS_WINDOW_SIZE,
  );
  const minSampleSize = readWholeNumber(
    config.get<string>(BINDING_STATS_MIN_SAMPLE_ENV),
    Math.min(DEFAULT_BINDING_STATS_MIN_SAMPLE, windowSize),
    BINDING_STATS_MIN_SAMPLE_ENV,
    1,
    windowSize,
  );
  return { windowSize, minSampleSize, maxAgeMs: BINDING_STATS_MAX_AGE_MS };
}

function readWholeNumber(
  raw: string | number | undefined,
  fallback: number,
  variable: string,
  min: number,
  max: number,
): number {
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${variable} must be a whole number from ${min} to ${max}, got "${raw}"`);
  }
  return value;
}
