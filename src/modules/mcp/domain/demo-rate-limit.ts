/**
 * How many public-demo calls one address may run.
 *
 * ## Two limits, protecting two different things
 *
 * ```text
 * this file            per IP, per window   protects the PROVIDER'S UPSTREAM
 * the agent's policy   per day, in money    protects the PLATFORM'S WALLET
 * ```
 *
 * Neither substitutes for the other. A spend policy alone would let one address
 * burn the entire daily budget against a stranger's endpoint in a minute; a
 * rate limit alone would let a patient crawler spend the budget over a day.
 * `SpendPolicyEnforcementService` supplies the second and is already on the
 * call path, so nothing here counts money.
 *
 * ## Pure, and why that matters here
 *
 * No clock, no Redis, no alert sink — the caller passes the count it read.
 * `RedisDemoRateLimiter` owns the sliding window. Keeping the decision separate
 * is what makes the boundaries (exactly at the ceiling, past it, and unreadable)
 * testable exhaustively, and those are the three cases that get this wrong in
 * production. `signing-rate-limit.ts` splits the same way for the same reason.
 *
 * ## It fails CLOSED
 *
 * An unreadable counter refuses. That is the opposite of the binding
 * ceilings, which fail open, and the difference is what sits behind each: a
 * binding ceiling protects throughput and erring toward serving is right, while
 * this protects somebody else's endpoint and money the platform pays. An
 * unauthenticated endpoint that stops counting is an open tap.
 */

export interface DemoRateLimits {
  /** Calls one address may make per window. `0` disables the demo entirely. */
  readonly perAddressPerWindow: number;
  /** The sliding window, in milliseconds. */
  readonly windowMs: number;
}

/**
 * Deliberately modest. This endpoint spends real money on a stranger's request
 * and calls a third party's API; the page is a demonstration, not a free tool.
 * Ten calls is more than enough to run both columns several times over.
 */
export const DEMO_RATE_LIMITS: DemoRateLimits = Object.freeze({
  perAddressPerWindow: 10,
  windowMs: 60_000,
});

export enum DemoRateDecision {
  ALLOWED = 'ALLOWED',
  RATE_LIMITED = 'RATE_LIMITED',
  /** The window could not be read. Refused rather than assumed empty. */
  COUNTER_UNAVAILABLE = 'COUNTER_UNAVAILABLE',
}

export interface DemoRateOutcome {
  readonly allowed: boolean;
  readonly reason: DemoRateDecision;
  /** Never negative — a concurrent burst can read past the ceiling. */
  readonly remaining: number;
}

export function decideDemoRate(input: {
  /** Calls already made in this window, or `null` when the counter is unreadable. */
  readonly used: number | null;
  readonly limits: DemoRateLimits;
}): DemoRateOutcome {
  if (input.used === null) {
    return { allowed: false, reason: DemoRateDecision.COUNTER_UNAVAILABLE, remaining: 0 };
  }

  const remaining = Math.max(0, input.limits.perAddressPerWindow - input.used);

  if (remaining === 0) {
    return { allowed: false, reason: DemoRateDecision.RATE_LIMITED, remaining: 0 };
  }

  return { allowed: true, reason: DemoRateDecision.ALLOWED, remaining };
}
