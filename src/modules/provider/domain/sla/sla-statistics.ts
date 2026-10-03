/**
 * The statistics an SLA window is judged by.
 *
 * Pure functions, no I/O, no clock — everything here is a number in and a
 * number out, because these are the four lines a provider will quote back at us
 * in a dispute and they have to be reproducible from the strike record alone.
 *
 * ## Two different intervals, on purpose
 *
 * The accountability model specifies **one** formula:
 *
 * ```text
 * tolerance = Z * sqrt(sla_threshold * (1 - sla_threshold) / n)
 * ```
 *
 * Note whose rate is inside the square root: the **declared** one, not the
 * observed one. That is deliberate and it is the reason {@link toleranceFor}
 * takes `declaredRate` rather than the observation. The question the threshold
 * answers is *"how far above their own number can an honest provider land by
 * sampling noise alone"*, which is a property of the null hypothesis, not of
 * the sample. Feeding the observed rate in would make the threshold move with
 * the very thing it is testing — a provider having a bad window would be
 * granted a wider tolerance for having one.
 *
 * The interval a provider **sees** ({@link wilsonInterval}) is a different
 * object: it is the uncertainty around *their* observation, and it is Wilson
 * rather than the same normal approximation because at the counts that matter
 * here the normal one is visibly wrong. With 2 failures in 50 calls the normal
 * interval runs from −1.1% to +9.1%, and a negative failure rate printed on a
 * provider's screen destroys the credibility of every other number next to it.
 * Wilson stays inside `[0, 1]` by construction.
 *
 * So: the **threshold** uses the formula above verbatim, and the **displayed
 * interval** uses Wilson. They are not two implementations of one thing.
 */

/** The observed rate, or `null` when nothing has been observed. */
export function observedRate(failedCalls: number, verifiedCalls: number): number | null {
  return verifiedCalls <= 0 ? null : failedCalls / verifiedCalls;
}

/**
 * `Z * sqrt(p(1-p)/n)` — the sampling error of an estimate of `p` at size `n`.
 *
 * Returns `null` for `n <= 0`: at zero observations the tolerance is not
 * infinite, it is undefined, and returning `Infinity` would let a caller
 * silently conclude "within tolerance" about a window with no data in it.
 */
export function toleranceFor(declaredRate: number, n: number, z: number): number | null {
  if (n <= 0) return null;
  return z * Math.sqrt((declaredRate * (1 - declaredRate)) / n);
}

/**
 * The rate a window must exceed to breach: the declaration plus its own
 * sampling error at this sample size.
 *
 * Shrinks as `n` grows, which is the whole point — high-volume bindings are
 * judged tightly and thin ones loosely, from one formula instead of from a
 * constant that is either useless at one end or lethal at the other.
 */
export function effectiveThreshold(declaredRate: number, n: number, z: number): number | null {
  const tolerance = toleranceFor(declaredRate, n, z);
  return tolerance === null ? null : declaredRate + tolerance;
}

export interface ConfidenceInterval {
  readonly lower: number;
  readonly upper: number;
}

/**
 * The Wilson score interval for a binomial proportion.
 *
 * ```text
 * centre = (p + z²/2n) / (1 + z²/n)
 * half   = z/(1 + z²/n) · sqrt( p(1−p)/n + z²/4n² )
 * ```
 *
 * Clamped to `[0, 1]` — the arithmetic already keeps it there, and the clamp is
 * against floating-point drift at the ends rather than against the formula.
 */
export function wilsonInterval(
  failedCalls: number,
  verifiedCalls: number,
  z: number,
): ConfidenceInterval | null {
  if (verifiedCalls <= 0) return null;

  const n = verifiedCalls;
  const p = failedCalls / n;
  const zz = z * z;
  const denominator = 1 + zz / n;
  const centre = (p + zz / (2 * n)) / denominator;
  const half = (z / denominator) * Math.sqrt((p * (1 - p)) / n + zz / (4 * n * n));

  return {
    lower: Math.min(1, Math.max(0, centre - half)),
    upper: Math.min(1, Math.max(0, centre + half)),
  };
}

/**
 * The scale the penalty rate is quantised to before it meets money.
 *
 * `excess_rate × PENALTY_MULTIPLIER` is a float and `total_call_amount` is a
 * `numeric(78,0)` that does not fit in a double. Multiplying them through
 * `Number()` would silently lose the low digits of any window whose turnover
 * exceeds 2⁵³ minor units, so the rate is turned into an integer numerator at
 * 1e-6 and the whole multiplication happens in `bigint`. A millionth of a
 * percentage point of a window's turnover is not a rounding anyone can dispute,
 * and it is a rounding that is *stated* rather than emergent.
 */
export const PENALTY_RATE_SCALE = 1_000_000n;

/**
 * `penalty = estimated_bad × avg_price × PENALTY_MULTIPLIER`, in minor units.
 *
 * Computed as `total_call_amount × excess_rate × multiplier`, which is the same
 * quantity with the `÷ total_calls` and `× total_calls` cancelled — the model
 * writes it in two steps because the *average price* is a number a provider
 * recognises, not because the division has to happen. Doing it in one step
 * removes a rounding that has no meaning.
 *
 * **`observed_rate` is already an estimate of the population rate**, so there is
 * no `÷ sample_rate` term anywhere here. An older worked example that divided
 * by `0.008` is superseded — see the note in {@link ./sla-window.ts}.
 *
 * Floors. A penalty is taken from someone; the fractional minor unit goes to
 * the party being charged.
 */
export function penaltyFor(
  totalCallAmount: bigint,
  excessRate: number,
  penaltyMultiplier: number,
): bigint {
  if (excessRate <= 0 || totalCallAmount <= 0n) return 0n;

  const scaledRate = BigInt(
    Math.round(excessRate * penaltyMultiplier * Number(PENALTY_RATE_SCALE)),
  );
  return (totalCallAmount * scaledRate) / PENALTY_RATE_SCALE;
}
