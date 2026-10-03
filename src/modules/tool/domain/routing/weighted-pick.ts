import { RoutingRandom, WeightedCandidate } from './routing.types';

/**
 * Weighted sampling — the last step of a routing decision.
 *
 * This is *weighted sampling, not argmax*, for two reasons:
 * it enforces the diversity floor, and it keeps every candidate's statistics
 * current. Argmax would send every call for a tool to whichever binding scored
 * highest by any margin, and the runners-up would stop producing observations
 * — so their scores would freeze at whatever they were on the day they lost,
 * and the router would be choosing between one live number and several fossils.
 *
 * The randomness is a parameter. A router that reached for `Math.random()`
 * could not have its distribution asserted against a known sequence, and
 * "traffic is split 60/30/10" would be a claim rather than a test.
 */
export function pickWeighted(
  weighted: readonly WeightedCandidate[],
  random: RoutingRandom,
): WeightedCandidate | null {
  if (weighted.length === 0) return null;

  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) {
    // Every weight is zero — nothing to sample proportionally, so sample
    // uniformly rather than always answering with the first entry. Not
    // reachable through `computeWeights` (which floors every weight above
    // zero), and handled anyway because the alternative silent failure mode is
    // one binding taking 100% of a tool's traffic.
    const index = Math.min(weighted.length - 1, Math.floor(random() * weighted.length));
    return weighted[index];
  }

  const target = random() * total;
  let cumulative = 0;

  for (const entry of weighted) {
    cumulative += entry.weight;
    if (target < cumulative) return entry;
  }

  // Floating-point drift: `random()` can return a value that rounds past the
  // accumulated total. The last entry is the correct answer, not a fallback —
  // the draw landed in its interval.
  return weighted[weighted.length - 1];
}
