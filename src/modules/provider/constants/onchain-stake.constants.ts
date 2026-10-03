/**
 * How long a chain reading of a provider's bonded stake is trusted.
 *
 * Two numbers, and they answer different questions. `STAKE_CACHE_TTL_MS` is
 * "how out of date may a reading be before we go and look again"; it is a load
 * question, and getting it wrong costs an RPC round trip. `STAKE_STALE_MAX_MS`
 * is "how out of date may a reading be before we refuse to make a money
 * decision with it"; it is a correctness question, and getting it wrong costs
 * either an outage or a provider taking paid traffic on collateral that is no
 * longer there.
 */

/**
 * Freshness window. Inside it, a cached reading is served without an RPC.
 *
 * Thirty seconds is chosen against what can actually change in that time.
 * Stake only *falls* by `request_unstake` (which moves `bonded` into
 * `unbonding`) or by `slash`, and both are transactions this platform either
 * initiates or is told about; neither happens without a human or a scheduled
 * job. Half a minute of a provider looking better-capitalised than they are is
 * bounded by the same minimum-stake floor that made them routable in the first
 * place, and the alternative — a chain read on the path of every routing
 * decision — puts an RPC round trip in front of every agent call.
 */
export const STAKE_CACHE_TTL_MS = 30_000;

/**
 * How long the last good reading may still be served **after the RPC starts
 * failing**, before the provider drops to "no known stake".
 *
 * This exists because `evaluateStakeGate` fails closed. Reading straight
 * through to the RPC would mean one timeout takes *every* paid binding out of
 * routing at once and every agent call gets a 503 — an availability incident
 * caused by a monitoring dependency rather than by anything being wrong with
 * the money. Fifteen minutes is long enough to ride out an RPC provider's
 * incident and a failover, and short enough that a slash or an unstake cannot
 * hide behind it for a meaningful amount of traffic.
 *
 * Past this, absent — which the gate turns into `STAKE_UNKNOWN` and refuses.
 * The tolerant side and the refusing side are both load-bearing: a "degrade"
 * with no upper bound is not a degrade, it is a cache that never expires, and
 * it would keep a slashed provider routable indefinitely.
 */
export const STAKE_STALE_MAX_MS = 15 * 60_000;

/** The env var an operator sets to move {@link STAKE_STALE_MAX_MS}. */
export const STAKE_STALE_MAX_MS_ENV = 'PROVIDER_STAKE_STALE_MAX_MS';

/** The env var an operator sets to move {@link STAKE_CACHE_TTL_MS}. */
export const STAKE_CACHE_TTL_MS_ENV = 'PROVIDER_STAKE_CACHE_TTL_MS';

/**
 * Redis key prefix, keyed by **stake authority** rather than by provider id.
 *
 * The cached fact is a property of the pubkey, not of the organization that
 * currently claims it. Keying by provider id would mean that re-proving a new
 * stake authority (the challenge/prove flow writes `providers.stake_authority` in place)
 * silently inherits the old wallet's balance for the rest of the TTL.
 */
export const STAKE_CACHE_KEY_PREFIX = 'provider:stake:onchain';
