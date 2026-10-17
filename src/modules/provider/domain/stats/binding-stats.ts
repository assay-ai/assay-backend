import { ProviderStats } from '../../ports/provider.types';

/**
 * Observed stats — the arithmetic, pure.
 *
 * ```text
 *   router ── attributeAttempt ──▶ binding_attempts ─┐
 *                                                   ├─ refresh (5 min) ─▶ binding_stats
 *   verification_records (PASS / FAIL) ─────────────┘                          │
 *                                                                               ▼
 *                       DbProviderRegistry ── deriveBindingStats / poolProviderStats
 * ```
 *
 * `binding_stats` holds raw counts and the two latency percentiles. Rates are
 * made here, at read time, so that the minimum sample size is applied in one
 * place and changing it takes effect on the next routing decision rather than
 * on the next refresh.
 */

/** One binding's window, as `binding_stats` stores it. */
export interface BindingWindow {
  readonly bindingId: string;
  readonly providerId: string;
  readonly attempts: number;
  readonly availableAttempts: number;
  readonly latencySamples: number;
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly verdicts: number;
  readonly passedVerdicts: number;
}

/**
 * One binding's `ProviderStats`, or the fields of it there is enough evidence
 * for.
 *
 * Each dimension has its own sample: availability counts attempts, latency
 * counts the attempts that carried a latency, quality counts verdicts. A field
 * whose sample is below `minSampleSize` is **absent**, never `0` and never
 * `undefined`-valued, so `score.ts` falls through to `NEUTRAL_PRIOR` exactly as
 * it did before anything was measured — and so a spread of this object over a
 * provider-level one only overrides what this binding actually measured.
 *
 * `freeQualityRate` is never set: free calls are not verified
 * (`tool_call_records.verdict` stays null), so there is nothing to measure it
 * from, and inventing one would route free traffic on a number nobody saw.
 */
export function deriveBindingStats(
  window: BindingWindowCounts,
  minSampleSize: number,
): ProviderStats {
  const stats: { -readonly [K in keyof ProviderStats]: ProviderStats[K] } = {};
  const floor = Math.max(1, minSampleSize);

  if (window.attempts >= floor) {
    stats.availabilityRate = ratio(window.availableAttempts, window.attempts);
  }
  if (window.latencySamples >= floor) {
    if (window.p50LatencyMs !== null) stats.p50LatencyMs = window.p50LatencyMs;
    if (window.p95LatencyMs !== null) stats.p95LatencyMs = window.p95LatencyMs;
  }
  if (window.verdicts >= floor) {
    stats.paidQualityRate = ratio(window.passedVerdicts, window.verdicts);
  }
  return stats;
}

/** The counts {@link deriveBindingStats} reads — a {@link BindingWindow} without its keys. */
export type BindingWindowCounts = Omit<BindingWindow, 'bindingId' | 'providerId'>;

/**
 * One provider's stats, pooled over its bindings' windows.
 *
 * The rates are exact: they are sums of counts over sums of counts, so a
 * provider whose busy binding is healthy and whose quiet one is broken reads
 * as mostly healthy, in proportion to the traffic each served.
 *
 * The latency percentiles are **not** exact — a percentile of a union cannot
 * be rebuilt from the percentiles of its parts — so the pooled figure is the
 * sample-weighted mean of the bindings' own percentiles. It is the fallback
 * for a binding with too little data of its own and the number a provider
 * sees on their profile; the router scores a binding on its own percentiles
 * whenever it has enough samples (`statsOf` in `domain/routing/score.ts`).
 */
export function poolProviderStats(
  windows: readonly BindingWindowCounts[],
  minSampleSize: number,
): ProviderStats {
  const pooled = {
    attempts: 0,
    availableAttempts: 0,
    latencySamples: 0,
    verdicts: 0,
    passedVerdicts: 0,
  };
  for (const window of windows) {
    pooled.attempts += window.attempts;
    pooled.availableAttempts += window.availableAttempts;
    pooled.latencySamples += window.latencySamples;
    pooled.verdicts += window.verdicts;
    pooled.passedVerdicts += window.passedVerdicts;
  }

  return deriveBindingStats(
    {
      ...pooled,
      p50LatencyMs: weightedPercentile(windows, (w) => w.p50LatencyMs),
      p95LatencyMs: weightedPercentile(windows, (w) => w.p95LatencyMs),
    },
    minSampleSize,
  );
}

function weightedPercentile(
  windows: readonly BindingWindowCounts[],
  read: (window: BindingWindowCounts) => number | null,
): number | null {
  let weight = 0;
  let sum = 0;
  for (const window of windows) {
    const value = read(window);
    if (value === null || window.latencySamples <= 0) continue;
    weight += window.latencySamples;
    sum += value * window.latencySamples;
  }
  return weight === 0 ? null : Math.round(sum / weight);
}

function ratio(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(1, Math.max(0, part / whole));
}

/** One binding's attempt half, as the refresh reads it. */
export type AttemptWindow = Pick<
  BindingWindow,
  | 'bindingId'
  | 'providerId'
  | 'attempts'
  | 'availableAttempts'
  | 'latencySamples'
  | 'p50LatencyMs'
  | 'p95LatencyMs'
>;

/** One binding's verdict half, as the refresh reads it. */
export type VerdictWindow = Pick<
  BindingWindow,
  'bindingId' | 'providerId' | 'verdicts' | 'passedVerdicts'
>;

/**
 * Join the two halves of the refresh on the binding. A binding can have
 * either half without the other — a free-only binding has attempts and no
 * verdicts, and a binding whose recent attempts aged out can still have
 * verdicts — and the missing half is zero counts, which reads as "not
 * measured" once {@link deriveBindingStats} applies the minimum sample.
 */
export function mergeWindows(
  attempts: readonly AttemptWindow[],
  verdicts: readonly VerdictWindow[],
): BindingWindow[] {
  const merged = new Map<string, BindingWindow>();
  for (const row of attempts) {
    merged.set(row.bindingId, { ...row, verdicts: 0, passedVerdicts: 0 });
  }
  for (const row of verdicts) {
    const existing = merged.get(row.bindingId);
    merged.set(
      row.bindingId,
      existing
        ? { ...existing, verdicts: row.verdicts, passedVerdicts: row.passedVerdicts }
        : {
            bindingId: row.bindingId,
            providerId: row.providerId,
            attempts: 0,
            availableAttempts: 0,
            latencySamples: 0,
            p50LatencyMs: null,
            p95LatencyMs: null,
            verdicts: row.verdicts,
            passedVerdicts: row.passedVerdicts,
          },
    );
  }
  return [...merged.values()];
}
