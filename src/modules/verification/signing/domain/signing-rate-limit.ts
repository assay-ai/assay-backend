/**
 * How many signatures are too many, and how many are enough to say something.
 *
 * ## Why a rate limit is the control, and not just a nice-to-have
 *
 * A verifier signature is one step from taking a provider's money. Every other
 * defence in the security model bounds what *one* forged
 * attestation can do — the slash cap, the timelock, the per-window replay
 * guard. None of them bounds how many an attacker can produce, and the attacker
 * who has the key does not need any single signature to look unusual. What
 * looks unusual is the *rate*.
 *
 * So this is the detector, and the journal is the record it reads on. The two
 * are the same mechanism seen from either end: the limit stops the burst, the
 * journal says who caused it.
 *
 * ## Two scopes, because they catch different things
 *
 * ```text
 * per key        the total, whoever asked. A stolen key used from anywhere.
 * per requester  one caller's share. A compromised worker, or a runaway loop
 *                inside a service that is otherwise behaving.
 * ```
 *
 * The per-key ceiling alone would let one broken caller consume the entire
 * budget and lock everyone else out while looking, from the key's point of
 * view, like ordinary load. The per-requester ceiling alone would miss a
 * distributed abuse that stays under the per-caller bar in every process.
 *
 * ## Warn well before refusing
 *
 * The threshold that refuses is not the threshold that is interesting. By the
 * time signing is refused, an attacker has already had the full budget; the
 * useful moment is when the rate first stops looking like production. Hence
 * {@link SigningRateLimits.warnRatio} — a fraction of the ceiling that raises an
 * alert while still allowing the signature. A control that only speaks when it
 * blocks is a control that tells you about the incident after it happened.
 *
 * Pure: no clock, no Redis, no alert sink. The counting is
 * `RedisSigningRateLimiter`'s and the alerting is `VerifierSigningService`'s;
 * what is *decided* is here, where it can be tested exhaustively.
 */

export interface SigningRateLimits {
  /** The window every count below is measured over. */
  readonly windowSeconds: number;
  /** Ceiling for one key, across every requester. */
  readonly perKey: number;
  /** Ceiling for one requester, on one key. */
  readonly perRequester: number;
  /**
   * Fraction of a ceiling at which the rate becomes worth saying out loud,
   * `0..1`. `0.5` alerts at half the budget.
   *
   * Below `1` or the warning arrives with the refusal and buys nothing; above
   * `0` or every signature is an alert and the alert stops being read, which is
   * the more common way a threshold like this fails.
   */
  readonly warnRatio: number;
}

/**
 * There is no published figure for this,
 * so these are chosen from what the system can actually produce rather than
 * from a source: attestations are issued **per SLA window, never per call**, and SLA windows are
 * hours long. A platform with a thousand providers therefore signs on the order
 * of a thousand times a day, not a minute.
 *
 * 60 per minute per key is roughly two orders of magnitude above that and still
 * three orders below what a script with a stolen key would do. The gap is the
 * whole value of the number: anything inside it is a config change, anything
 * outside it is not a busy day.
 *
 * These are the shipped defaults and every one is overridable
 * (`VERIFIER_SIGNING_RATE_*`) — the first deployment with real traffic should
 * replace them with measurements.
 */
export const DEFAULT_SIGNING_RATE_LIMITS: SigningRateLimits = Object.freeze({
  windowSeconds: 60,
  perKey: 60,
  perRequester: 30,
  warnRatio: 0.5,
});

/** One scope's count against its ceiling, as observed by the counter. */
export interface RateWindowObservation {
  /** `key:verifier-2026-08` / `requester:worker:verification-judge`. */
  readonly scope: string;
  /** Attempts in the window **including this one**. See {@link decideSigningRate}. */
  readonly observed: number;
  readonly limit: number;
}

export enum SigningRateVerdict {
  ALLOW = 'ALLOW',
  /** Allowed, and somebody should be told. */
  ALLOW_AND_ALERT = 'ALLOW_AND_ALERT',
  REFUSE = 'REFUSE',
}

export interface SigningRateDecision {
  readonly verdict: SigningRateVerdict;
  /** The scope that hit its ceiling. `null` unless refused. */
  readonly breached: RateWindowObservation | null;
  /** Every scope at or past `warnRatio`, breached or not. Never empty when alerting. */
  readonly elevated: readonly RateWindowObservation[];
}

/**
 * Decide, given what the counter saw.
 *
 * `observed` **includes the attempt being decided**, and it includes attempts
 * that were themselves refused. Both are deliberate:
 *
 * - Counting the current attempt makes the ceiling mean what it says. Deciding
 *   on the count *before* the increment lets exactly `limit + 1` through.
 * - Counting refused attempts is what makes the limit a limit. If a refusal did
 *   not count, an attacker parked at the ceiling would get an unlimited number
 *   of further attempts for free, each one refused and each one costing nothing
 *   — and the moment a legitimate request expired out of the window, theirs
 *   would take the slot. The cost is that a burst of abuse also delays honest
 *   signing, which is the correct trade for a key whose misuse drains provider
 *   stake: refusing to sign halts attestations and takes nobody's money.
 */
export function decideSigningRate(
  observations: readonly RateWindowObservation[],
  limits: SigningRateLimits,
): SigningRateDecision {
  const elevated = observations.filter((o) => o.observed >= Math.ceil(o.limit * limits.warnRatio));
  // The *first* breach in the order given, so the caller controls which scope is
  // named when several are over at once — the narrower one is more actionable.
  const breached = observations.find((o) => o.observed > o.limit) ?? null;

  if (breached) {
    return { verdict: SigningRateVerdict.REFUSE, breached, elevated };
  }
  return {
    verdict: elevated.length > 0 ? SigningRateVerdict.ALLOW_AND_ALERT : SigningRateVerdict.ALLOW,
    breached: null,
    elevated,
  };
}
