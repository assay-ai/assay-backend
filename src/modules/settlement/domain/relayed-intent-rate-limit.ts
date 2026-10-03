/**
 * How much of the relayer's gas one buyer, and one organization, may spend in
 * an hour.
 *
 * ## Why a rate limit is the control here
 *
 * `POST /escrow/limits` and `POST /escrow/withdrawals/request` are a public
 * money-path surface in one specific sense: a caller supplies a signature and
 * **the platform pays the gas to submit it**. Every other control on the path
 * bounds what a *single* submission can do — the session binding says whose
 * request it may be, the pre-flight `eth_estimateGas` says it must be one the
 * chain will accept, the gas ceiling says what it may cost. None of them bounds
 * *how many*.
 *
 * And a valid signature is not self-limiting. The obvious abuse — resubmitting
 * one request over and over — is already free for the platform: the second
 * submission fails `BadNonce` at the pre-flight and never reaches the chain.
 * The abuse that is *not* free is a buyer who signs a fresh `SetLimits` at each
 * new `authNonce` and posts it. Each one is genuine, each one lands, and each
 * one costs the relayer ~65,000 gas. Nothing in the contract stops that, and
 * nothing should: the contract's job is to do what the buyer signed.
 *
 * ## Two scopes, and deliberately no global one
 *
 * ```text
 * account        one buyer's share. A runaway console, or one hostile buyer.
 * organization   one tenant's share, across every buyer account it holds.
 * ```
 *
 * The account scope alone is defeated by a tenant that holds many buyer
 * accounts; the organization scope is the boundary this platform already meters
 * everything else on.
 *
 * **There is no global ceiling, and that is a decision rather than an
 * omission.** A global ceiling would let one attacker who is willing to burn
 * their own budget lock every unrelated buyer out of their own brake and their
 * own exit — turning a bound on our ETH into a denial of service on other
 * people's money. The residual is stated plainly: an attacker who can create N
 * organizations gets N × {@link RelayedIntentRateLimits.perOrganization}
 * submissions an hour. What stops that is the relayer's float alert
 * (`evm_relayer_float_low`, emitted after every send and again on a 5-minute
 * pass) and the fact that creating organizations is not anonymous — not this
 * file.
 *
 * Pure: no clock, no Redis, no HTTP. The counting is
 * `RelayedIntentRateLimiter`'s; what is *decided* is here, where it can be
 * tested exhaustively.
 */

export interface RelayedIntentRateLimits {
  /** The window every count below is measured over. */
  readonly windowSeconds: number;
  /** Ceiling for one buyer account. */
  readonly perAccount: number;
  /** Ceiling for one organization, across every account it holds. */
  readonly perOrganization: number;
}

/**
 * Chosen from what a buyer can legitimately produce, not from a published
 * figure — there is none.
 *
 * A buyer lowers their voucher ceiling when they change how they spend, and
 * starts an exit when they leave. Both are human-paced actions measured in
 * *per month*, not per hour. Ten an hour is roughly two orders of magnitude
 * above that and still four orders below what a script would do, which is the
 * whole value of the gap: anything inside it is a config change, anything
 * outside it is not a busy afternoon.
 *
 * The cost of being wrong is asymmetric and is why the numbers sit where they
 * do. Too low and a legitimate buyer is told to wait an hour before lowering a
 * ceiling — annoying, visible, and it costs nobody any money, since `withdraw()`
 * itself never passes through this route. Too high and the relayer's float
 * drains: at the 300,000-gas ceiling a relayed request may cost, `perAccount:
 * 10` bounds one buyer at 3,000,000 gas an hour, which at 0.1 gwei is
 * 0.0003 ETH — under 1 % of the ≤ 0.05 ETH float the port targets.
 */
export const DEFAULT_RELAYED_INTENT_RATE_LIMITS: RelayedIntentRateLimits = Object.freeze({
  windowSeconds: 3600,
  perAccount: 10,
  perOrganization: 50,
});

/** One scope's count against its ceiling, as the counter observed it. */
export interface RelayedIntentObservation {
  /** `account:eip155:46630:0x…` / `organization:7e3a94c1-…`. */
  readonly scope: string;
  /** Attempts in the window **including this one**. See {@link decideRelayedIntentRate}. */
  readonly observed: number;
  readonly limit: number;
}

/**
 * The scope that is over its ceiling, or `null`.
 *
 * `observed` **includes the attempt being decided**, and it includes attempts
 * that were themselves refused. Both are deliberate, and the reasoning is
 * `decideSigningRate`'s:
 *
 * - Counting the current attempt makes the ceiling mean what it says. Deciding
 *   on the count *before* the increment lets exactly `limit + 1` through.
 * - Counting refused attempts is what makes the limit a limit. A refusal that
 *   did not count would give an attacker parked at the ceiling an unlimited
 *   number of further attempts for free — and each one still costs an
 *   `eth_estimateGas` against the node, which is the RPC budget this also
 *   protects.
 *
 * The **first** breach in the order given is named, so the caller controls
 * which scope a buyer is told about; the narrower one is more actionable.
 */
export function decideRelayedIntentRate(
  observations: readonly RelayedIntentObservation[],
): RelayedIntentObservation | null {
  return observations.find((observation) => observation.observed > observation.limit) ?? null;
}
