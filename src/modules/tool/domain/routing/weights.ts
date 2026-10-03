import { RoutingCandidate, ScoredCandidate, WeightedCandidate } from './routing.types';

/**
 * Traffic shares, and the diversity floor.
 *
 * ```typescript
 * export const MAX_PROVIDER_SHARE = 0.6;
 * ```
 *
 * No provider **earns** more than 60% of a tool's traffic, however well it
 * scores. This is **not fairness** — it is operational, and the argument is
 * worth keeping next to the code because the cap looks like a cost until the
 * day it pays:
 *
 * - A fallback provider that has served no traffic has no *current* statistics.
 *   It may have been silently broken for a month, and we would find out at the
 *   moment we urgently needed it. The floor keeps every alternative measured
 *   and warm.
 * - It bounds the blast radius. One provider failing takes at most 68% of a
 *   tool's traffic with it, and the rest is already flowing somewhere that is
 *   known to work.
 *
 * **68, not 60, and the difference is the exploration floor.** The cap
 * governs the share a provider *earns* by score; the floor is reserved before
 * that allocation runs, so a provider holding a new binding reaches
 * `0.6 × (1 − 0.2) + 0.2 = 0.68` in the worst case. Measured by brute force
 * over the configuration space, not assumed. It is hard-bounded by
 * `EXPLORATION_BUDGET` and it ends by itself once the binding passes
 * `EXPLORATION_CALL_THRESHOLD`.
 *
 * The 60% is therefore not absolute: a rule stating it as absolute predates the
 * exploration floor and describes a system that could not measure a new binding.
 *
 * The cap is why selection is **weighted sampling and not argmax**. Argmax
 * sends 100% of traffic to whoever scores highest by any margin, however small,
 * and produces exactly the concentration the cap forbids.
 */

export const MAX_PROVIDER_SHARE = 0.6;

/**
 * A score of zero must not mean a weight of zero.
 *
 * A candidate that can never be sampled can never generate the observations
 * that would change its score, so a zero weight is permanent by construction.
 * This floor is small enough to be invisible against any real score and large
 * enough to keep the candidate reachable — and it also keeps the normalisation
 * below from dividing by zero when every candidate scores 0, which is what a
 * fresh catalogue with no statistics at all looks like.
 */
const MIN_RAW_WEIGHT = 1e-6;

/**
 * How many lifetime calls a binding serves before it stops being "new".
 *
 * The same 1,000 that `NEUTRAL_PRIOR` in `score.ts` cites, and deliberately the
 * same number: the prior is a placeholder that says "nothing is known", and
 * this is the point at which enough is known that the placeholder stops being
 * the honest answer. Two different thresholds would mean a window where a
 * binding is scored on real statistics and still subsidised as if it had none.
 *
 * Counted per BINDING and over its lifetime — see `RoutingCandidate.observedCalls`
 * for why the provider-level count next to it is the wrong number.
 */
export const EXPLORATION_CALL_THRESHOLD = 1000;

/**
 * The share of a tool's traffic reserved for one new binding — the 5% floor.
 *
 * A floor, not an allocation: a new binding also competes on score for the
 * rest, so this is what it gets *in addition to* whatever it earns. Below this
 * a binding cannot accumulate observations fast enough to leave exploration in
 * any reasonable time; much above it and the platform is paying for elevated
 * verification on traffic it did not need to buy.
 */
export const EXPLORATION_FLOOR_SHARE = 0.05;

/**
 * The total reserved across ALL new bindings, however many there are.
 *
 * Without it the floor is an open invitation: twenty new bindings would reserve
 * 100% of the tool and every established binding — the ones actually known to
 * work — would be squeezed to nothing, which is the failure the diversity cap
 * exists to prevent, arrived at from the other direction. Past four explorers
 * the budget binds and each one gets `0.20 / |E|` rather than 5%.
 *
 * Exploration also runs at 100% verification sampling, which the platform pays
 * for. That makes this number a hard cost ceiling as well as a traffic one.
 */
export const EXPLORATION_BUDGET = 0.2;

/**
 * Is this binding still inside its exploration window?
 *
 * Exported because the sampling half of the rule ("100% verification sampling
 * during this period") has to answer the same question about the same binding.
 * Two copies of `observedCalls !== null && observedCalls < 1000` would drift,
 * and the drift would be silent: traffic and sampling would disagree about
 * which bindings are new, so the platform would either pay for verification on
 * traffic that is no longer exploratory or route exploratory traffic it never
 * verifies — and the second one is the expensive direction, because the whole
 * point of the floor is to BUY observations.
 *
 * `null` is excluded rather than treated as new. It means the counter was not
 * read, and reading zero into "new" is the permissive direction: with no
 * loader wired the field is `null` everywhere, every binding would look new
 * forever, and the 20% budget would never switch off — while every test still
 * passed. So the floor degrades OFF, and the tests pin that.
 */
export function isExploring(candidate: RoutingCandidate): boolean {
  const observed = candidate.observedCalls;
  return observed !== null && observed < EXPLORATION_CALL_THRESHOLD;
}

/**
 * Turn scores into the share of traffic each binding should receive, with the
 * exploration floor applied on top.
 *
 * A brand-new binding has no quality statistics, so it scores at the neutral
 * prior and earns whatever that is worth next to a provider with a year of
 * history — which is close to nothing. It therefore never serves the calls that
 * would give it statistics. The loop is closed and it closes against every new
 * provider the platform wants to onboard, so the floor is not a nicety: it is
 * the supply side of the marketplace working at all.
 *
 * **The order is the whole design**, because a per-binding floor and a
 * per-provider cap have no obvious relationship and two people will otherwise
 * build two different things:
 *
 * 1. `E` = the candidates still exploring (see {@link isExploring}).
 * 2. **Reserve first.** `R = min(EXPLORATION_BUDGET, 0.05 × |E|)`, split evenly
 *    across `E`. This comes off the top, before any score is consulted.
 * 3. The remaining `1 − R` runs through {@link computeBaseWeights} unchanged —
 *    still per provider, still water-filled against the cap — and the members
 *    of `E` still take part in it on score. The floor is a floor, not a cap.
 * 4. `weight = floor (if in E) + (1 − R) × base weight`.
 *
 * There is deliberately **no renormalisation pass**. The total is 1 by
 * construction (`R + (1 − R) × 1`), and normalising would divide the floors
 * created in step 2 back down — quietly delivering less than the 5% the whole
 * mechanism is named after, while still summing to 1 and looking correct.
 *
 * **The consequence, stated rather than discovered:** the 60% diversity cap now
 * governs the *earned* share, not the total. A provider holding new bindings
 * can reach `0.6 × 0.8 + 0.2 = 0.68` of a tool. That is the price of measuring
 * a binding nobody knows anything about; it is hard-capped by
 * `EXPLORATION_BUDGET` and it ends by itself at 1,000 calls. The alternative —
 * carving the floor out of that provider's own ≤60% — gives a new binding from
 * a capped provider almost nothing, which is no floor exactly where one is
 * needed most.
 *
 * Both arities are load-bearing: `select()` passes the configured cap,
 * `quoteTool` calls this with one argument.
 */
export function computeWeights(
  scored: readonly ScoredCandidate[],
  maxProviderShare: number = MAX_PROVIDER_SHARE,
): WeightedCandidate[] {
  if (scored.length === 0) return [];

  const exploring = scored.map((entry) => isExploring(entry.candidate));
  const explorers = exploring.filter(Boolean).length;
  const base = computeBaseWeights(scored, maxProviderShare);

  // Nothing is new: not "a reserve that rounds to zero", but no reserve at all,
  // so a tool with no new bindings distributes exactly as it did before the
  // floor existed.
  if (explorers === 0) return base;

  const reserved = Math.min(EXPLORATION_BUDGET, EXPLORATION_FLOOR_SHARE * explorers);
  const floor = reserved / explorers;

  return base.map((entry, index) => ({
    ...entry,
    weight: (exploring[index] ? floor : 0) + (1 - reserved) * entry.weight,
  }));
}

/**
 * Turn scores into the share of traffic each binding should receive.
 *
 * Two levels, and the order matters:
 *
 * 1. Scores are normalised into shares *per provider* — a provider with three
 *    bindings for one tool is one competitor, not three. Normalising per
 *    binding would let a provider raise its own share by publishing duplicate
 *    bindings, which is a cap that pays to be circumvented.
 * 2. The cap is applied by water-filling: whoever is over 60% is clamped to it,
 *    the excess is redistributed proportionally among those who are not, and
 *    the pass repeats because redistribution can push a second provider over.
 * 3. Each provider's share is split across its own bindings in proportion to
 *    their scores.
 *
 * The returned weights sum to 1 (within floating-point tolerance).
 *
 * Private, and called exactly once — from {@link computeWeights}, over the
 * `1 − R` that the exploration floor did not reserve. Kept as its own function
 * rather than folded in because the two rules answer different questions
 * ("who has earned this traffic" against "what has not been measured yet"), and
 * because a `computeWeights` that recursed into itself to apply the floor would
 * reserve a second time on the inner pass.
 */
function computeBaseWeights(
  scored: readonly ScoredCandidate[],
  maxProviderShare: number,
): WeightedCandidate[] {
  if (scored.length === 0) return [];

  const raw = scored.map((entry) => Math.max(entry.score, MIN_RAW_WEIGHT));

  // ── Group by provider ────────────────────────────────────────────────────
  const byProvider = new Map<string, number[]>();
  scored.forEach((entry, index) => {
    const providerId = entry.candidate.binding.providerId;
    const members = byProvider.get(providerId);
    if (members) members.push(index);
    else byProvider.set(providerId, [index]);
  });

  const providers = [...byProvider.entries()].map(([providerId, indices]) => ({
    providerId,
    indices,
    raw: indices.reduce((sum, index) => sum + raw[index], 0),
  }));

  const shares = allocateProviderShares(providers, maxProviderShare);

  // ── Split each provider's share across its own bindings ──────────────────
  const weights = new Array<number>(scored.length).fill(0);
  for (const provider of providers) {
    const share = shares.get(provider.providerId) ?? 0;
    const total = provider.raw;
    for (const index of provider.indices) {
      weights[index] = total > 0 ? (share * raw[index]) / total : share / provider.indices.length;
    }
  }

  return scored.map((entry, index) => ({
    candidate: entry.candidate,
    score: entry.score,
    weight: weights[index],
  }));
}

interface ProviderGroup {
  readonly providerId: string;
  readonly indices: readonly number[];
  readonly raw: number;
}

/**
 * Water-fill the provider shares against the cap.
 *
 * The one case the cap cannot be honoured is when there are too few providers
 * for it to be arithmetically possible — with a 60% cap, a tool served by a
 * single provider. Shares must still sum to 1, so the cap yields rather than
 * the total: a sole provider gets 100%. That is the honest outcome, and it is
 * also the signal the launch catalogue cares about, since a tool with one provider is a tool
 * with no failover at all.
 */
function allocateProviderShares(
  providers: readonly ProviderGroup[],
  cap: number,
): Map<string, number> {
  const shares = new Map<string, number>();
  const totalRaw = providers.reduce((sum, p) => sum + p.raw, 0);

  if (providers.length * cap < 1 || totalRaw <= 0) {
    for (const provider of providers) {
      shares.set(
        provider.providerId,
        totalRaw > 0 ? provider.raw / totalRaw : 1 / providers.length,
      );
    }
    return shares;
  }

  let pool = [...providers];
  let remaining = 1;

  while (pool.length > 0) {
    const poolRaw = pool.reduce((sum, p) => sum + p.raw, 0);
    const over = pool.filter((p) => (remaining * p.raw) / poolRaw > cap);

    if (over.length === 0) {
      for (const provider of pool) {
        shares.set(provider.providerId, (remaining * provider.raw) / poolRaw);
      }
      break;
    }

    for (const provider of over) {
      shares.set(provider.providerId, cap);
      remaining -= cap;
    }

    const clamped = new Set(over.map((p) => p.providerId));
    pool = pool.filter((p) => !clamped.has(p.providerId));

    // Everyone hit the cap. Only reachable when `providers.length * cap` is
    // exactly 1, so the leftover is zero and there is nothing to redistribute.
    if (pool.length === 0 && remaining > 1e-9) {
      const bonus = remaining / providers.length;
      for (const provider of providers) {
        shares.set(provider.providerId, (shares.get(provider.providerId) ?? 0) + bonus);
      }
    }
  }

  return shares;
}
