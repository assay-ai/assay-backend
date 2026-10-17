import { ProviderStats, ProviderTier } from '@modules/provider/ports/provider.types';
import { MONEY_MAX_ATOMIC_UNITS } from '@utils/money.util';

import { PricingMode } from '../../ports/tool.types';
import { RoutingCandidate, ScoreWeights, ScoredCandidate } from './routing.types';

/**
 * Scoring.
 *
 * ```text
 * score = 0.40 × quality
 *       + 0.25 × availability
 *       + 0.15 × latency
 *       + 0.15 × price
 *       + 0.05 × tier
 * ```
 *
 * Every component is normalised to `[0, 1]` before weighting, so the weights
 * mean what they look like they mean. Two of the five are *relative* to the
 * other candidates for the same tool rather than absolute — price and latency —
 * because "expensive" and "slow" have no meaning except against the
 * alternatives available for that call.
 */

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = Object.freeze({
  quality: 0.4,
  availability: 0.25,
  latency: 0.15,
  price: 0.15,
  tier: 0.05,
});

/**
 * What an unmeasured rate scores.
 *
 * A provider that has served nothing has no `qualityRate`, and the two obvious
 * defaults are both wrong. Scoring it `0` means "measured, and terrible", which
 * starves it of exactly the traffic it needs to earn a real number — a new
 * provider would never be routed to, so it would never stop being new.
 * Scoring it `1` floods it with traffic on the strength of having no record.
 *
 * `0.5` says what is true: nothing is known. On its own it is not enough — a
 * neutral score still loses to a measured good one, so the traffic that would
 * replace the placeholder never arrives. The floor that does arrive is
 * the explore/exploit floor, and it lives in `weights.ts`
 * (`EXPLORATION_CALL_THRESHOLD` is the same 1,000 calls this comment used to
 * only cite). Scoring stays honest about ignorance; the floor is what pays for
 * ending it.
 */
export const NEUTRAL_PRIOR = 0.5;

const TIER_BONUS: Readonly<Record<ProviderTier, number>> = Object.freeze({
  [ProviderTier.NEW]: 0,
  [ProviderTier.ESTABLISHED]: 0.5,
  [ProviderTier.TRUSTED]: 1,
});

/**
 * Score every candidate for one tool call.
 *
 * Plural by necessity, not by convenience: price and latency are normalised
 * across the candidate set, so scoring one binding in isolation is not a
 * defined operation. A `scoreOne(binding)` would have to invent a reference
 * price, and that invented number would decide routing.
 */
export function scoreCandidates(
  candidates: readonly RoutingCandidate[],
  weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS,
): ScoredCandidate[] {
  const prices = candidates.map((c) => toBigInt(c.binding.priceAmount));
  const cheapest = prices.reduce((min, p) => (p < min ? p : min), prices[0] ?? 0n);
  const dearest = prices.reduce((max, p) => (p > max ? p : max), prices[0] ?? 0n);

  return candidates.map((candidate, index) => {
    const { binding, provider } = candidate;
    const stats = statsOf(candidate);

    // Free and paid traffic route on separate quality rates. A provider running
    // a deliberately degraded free tier is legitimate; mixing the two would let
    // that degradation drag down the number paid traffic is routed on, and
    // would let a good free tier subsidise a bad paid one.
    const quality =
      binding.pricingMode === PricingMode.FREE
        ? (stats.freeQualityRate ?? NEUTRAL_PRIOR)
        : (stats.paidQualityRate ?? NEUTRAL_PRIOR);

    const availability = stats.availabilityRate ?? NEUTRAL_PRIOR;

    // p95, normalised against *this binding's* timeout rather than a global
    // constant: a provider whose p95 is 4s is fast for a 30s tool and unusable
    // for a 5s one, and the timeout is the only number that knows which.
    const latency =
      stats.p95LatencyMs === undefined || binding.timeoutMs <= 0
        ? NEUTRAL_PRIOR
        : clamp01(1 - stats.p95LatencyMs / binding.timeoutMs);

    const price = normalisePrice(prices[index], cheapest, dearest);
    const tier = TIER_BONUS[provider.tier] ?? 0;

    const components = { quality, availability, latency, price, tier };

    const score =
      weights.quality * quality +
      weights.availability * availability +
      weights.latency * latency +
      weights.price * price +
      weights.tier * tier;

    return { candidate, score, components };
  });
}

/**
 * The stats a candidate is scored on: its binding's own, field by field, over
 * its provider's pooled figure.
 *
 * Per field rather than all-or-nothing because each field has its own sample:
 * a binding with 300 attempts and 12 verdicts has a measured availability and
 * an unmeasured quality, and the provider's pooled quality is a better answer
 * for the second than the neutral prior. A field neither level measured is
 * absent, and `scoreCandidates` scores it `NEUTRAL_PRIOR`.
 *
 * Exported because the quote publishes the same figures it routes on.
 */
export function statsOf(candidate: RoutingCandidate): ProviderStats {
  const own = candidate.provider.bindingStats?.get(candidate.binding.id);
  return own ? { ...candidate.provider.stats, ...own } : candidate.provider.stats;
}

/**
 * Cheapest scores 1, dearest scores 0, everything else linearly between.
 *
 * When every candidate costs the same the spread is zero, and the answer is 1
 * for all of them rather than 0: price is not a reason to prefer any of them,
 * and scoring them all 0 would silently discard 15% of the score's range for
 * the whole tool.
 */
function normalisePrice(price: bigint, cheapest: bigint, dearest: bigint): number {
  if (dearest <= cheapest) return 1;
  const span = dearest - cheapest;
  // bigint throughout, then one division at the end. Prices are `u64` atomic
  // units and can exceed `Number.MAX_SAFE_INTEGER`; converting first would make
  // two distinguishable prices compare equal.
  return Number(((dearest - price) * 10_000n) / span) / 10_000;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function toBigInt(amount: string): bigint {
  try {
    return BigInt(amount);
  } catch {
    // An unparseable price is a corrupt binding row, not a free tool. It scores
    // as the most expensive thing representable, because the other direction —
    // falling back to `0` — would make a corrupt row the cheapest candidate and
    // hand it the price component outright.
    return MONEY_MAX_ATOMIC_UNITS;
  }
}
