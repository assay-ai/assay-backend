import { ProviderTier } from '@modules/provider/ports/provider.types';
import { MAX_PROVIDER_SHARE, computeWeights, scoreCandidates } from '@modules/tool/domain/routing';

import { buildCandidate, buildProvider } from './helpers/routing-fixtures';

/**
 * The exploration floor (explore/exploit).
 *
 * A brand-new binding has no quality statistics, so it scores at
 * `NEUTRAL_PRIOR` and earns whatever share that buys — which next to an
 * established competitor is close to nothing. That is a closed loop: no data,
 * so no traffic, so no data. The floor breaks it by reserving traffic *before*
 * scores are consulted.
 *
 * Every number in this file is written as a literal rather than imported from
 * `weights.ts`. A test that asserts `weight === EXPLORATION_FLOOR_SHARE` passes
 * no matter what that constant is changed to, which is exactly the change these
 * tests exist to catch.
 */
describe('computeWeights — the exploration floor', () => {
  const IDS = ['provider-a', 'provider-b', 'provider-c', 'provider-d', 'provider-e', 'provider-f'];

  /**
   * Six providers, one binding each, all scoring identically.
   *
   * Identical scores are what makes the floor legible: every base share is
   * exactly 1/6, so the gap between an exploring binding and a non-exploring
   * one *is* the floor, with nothing else in it. `observed[i]` is the lifetime
   * call count of provider `i`'s binding.
   */
  const sixWith = (observed: readonly (number | null)[]) =>
    computeWeights(
      scoreCandidates(IDS.map((id, i) => buildCandidate(id, { observedCalls: observed[i] }))),
    );

  const weightOf = (
    weights: readonly { candidate: { binding: { providerId: string } }; weight: number }[],
    providerId: string,
  ) => weights.find((w) => w.candidate.binding.providerId === providerId)!.weight;

  /** Nobody explores: the six split the tool evenly. The reference case. */
  const SETTLED = 1 / 6;

  /** Wins on every axis — unclamped it would take ~75% of the tool. */
  const DOMINANT = {
    tier: ProviderTier.TRUSTED,
    stats: { availabilityRate: 1, paidQualityRate: 1, p95LatencyMs: 50 },
  };
  /** Alive, and nothing more. Only the cap keeps traffic flowing to it. */
  const BARELY_ALIVE = {
    tier: ProviderTier.NEW,
    stats: { availabilityRate: 0.02, paidQualityRate: 0.02, p95LatencyMs: 5_000 },
  };

  it('gives each exploring binding exactly 0.05 when |E| <= 4', () => {
    // A, B, C and D are new; E and F are established. |E| = 4, so the budget is
    // 0.05 × 4 = 0.20 and is NOT yet the binding constraint — each of the four
    // gets the full 5%.
    const weights = sixWith([0, 500, 999, 0, 5_000, 50_000]);

    // The reserve is 0.20, so the earned allocation is scaled to 0.80.
    const earned = 0.8 * SETTLED;

    for (const id of ['provider-a', 'provider-b', 'provider-c', 'provider-d']) {
      expect(weightOf(weights, id)).toBeCloseTo(0.05 + earned, 9);
      // Stated as a difference too, because that is the claim: 5% of the tool's
      // traffic, on top of whatever the binding earns on score.
      expect(weightOf(weights, id) - weightOf(weights, 'provider-f')).toBeCloseTo(0.05, 9);
    }

    expect(weightOf(weights, 'provider-e')).toBeCloseTo(earned, 9);
    expect(weightOf(weights, 'provider-f')).toBeCloseTo(earned, 9);
  });

  it('splits the 0.20 budget when |E| > 4 — 0.20/|E| each, NOT 0.05', () => {
    // Five new bindings would want 0.25 between them. The budget caps the total
    // at 0.20 and the floor per binding shrinks; it does not stay at 5% and
    // overrun.
    const weights = sixWith([0, 0, 0, 0, 0, 50_000]);

    const earned = 0.8 * SETTLED;

    for (const id of ['provider-a', 'provider-b', 'provider-c', 'provider-d', 'provider-e']) {
      expect(weightOf(weights, id) - weightOf(weights, 'provider-f')).toBeCloseTo(0.2 / 5, 9);
      expect(weightOf(weights, id) - weightOf(weights, 'provider-f')).not.toBeCloseTo(0.05, 9);
      expect(weightOf(weights, id)).toBeCloseTo(0.2 / 5 + earned, 9);
    }

    // The total reserved is 0.20 however many bindings share it.
    const reserved = ['provider-a', 'provider-b', 'provider-c', 'provider-d', 'provider-e'].reduce(
      (sum, id) => sum + (weightOf(weights, id) - weightOf(weights, 'provider-f')),
      0,
    );
    expect(reserved).toBeCloseTo(0.2, 9);
  });

  it('excludes a binding with observedCalls = null from E', () => {
    // `null` means the counter was not read — NOT that the binding is new. If
    // it were treated as new, every binding would be new forever (whenever the
    // loader does not populate the field) and the 20% budget would
    // never switch off.
    //
    // The fixture MUST be asymmetric. An all-`null` set of six equal scores is
    // immune to the bug it is meant to catch: under `(observed ?? 0) < 1000`
    // every candidate explores, so each gets `0.2/6 + 0.8 × (1/6)`, which is
    // the SAME DOUBLE as `1/6` — not close, identical, so even an exact
    // comparison passes. Mutation-tested: the all-`null` version of this test
    // stayed green under that exact mutation.
    //
    // One non-explorer is what makes the difference observable. Correct code
    // gives it and the `null` bindings the same weight; the mutant hands the
    // five `null`s a floor the sixth does not get.
    const weights = sixWith([null, null, null, null, null, 50_000]);

    const settledSixth = weightOf(weights, 'provider-f');
    for (const id of IDS) {
      expect(weightOf(weights, id)).toBeCloseTo(SETTLED, 9);
      // The assertion that actually bites: no candidate is above the one
      // binding we KNOW is not exploring.
      expect(weightOf(weights, id) - settledSixth).toBeCloseTo(0, 9);
    }

    // Byte-for-byte the pre-floor behaviour: the floor degrades OFF when the
    // count is unavailable, which is the fail-closed direction.
    const settled = sixWith([9_999, 9_999, 9_999, 9_999, 9_999, 9_999]);
    expect(weights.map((w) => w.weight)).toEqual(settled.map((w) => w.weight));
  });

  it('excludes a binding with >= 1000 observed calls from E', () => {
    // The boundary, from both sides. 999 explores, 1000 does not — which is
    // what "the first 1,000 calls" means and is how the floor turns itself OFF
    // without anyone switching it off.
    const weights = sixWith([999, 1_000, 1_001, 50_000, 50_000, 50_000]);

    const earned = 0.95 * SETTLED;

    expect(weightOf(weights, 'provider-a')).toBeCloseTo(0.05 + earned, 9);
    for (const id of ['provider-b', 'provider-c', 'provider-d', 'provider-e', 'provider-f']) {
      expect(weightOf(weights, id)).toBeCloseTo(earned, 9);
    }
  });

  it('does not read the provider-level lifetime count in place of the binding one', () => {
    // Every fixture provider has served 50,000 calls (`ProviderStats.callsServed`),
    // and its brand-new binding has served none. Reaching for the provider-level
    // number compiles, passes the other tests, and means an established
    // provider's new binding is never explored.
    const provider = buildProvider('provider-a');
    expect(provider.stats.callsServed).toBe(50_000);

    const weights = sixWith([0, 50_000, 50_000, 50_000, 50_000, 50_000]);
    expect(weightOf(weights, 'provider-a') - weightOf(weights, 'provider-b')).toBeCloseTo(0.05, 9);
  });

  it('sums to 1 with no renormalisation step', () => {
    // `R + (1 − R) × 1 = 1` by construction, so no normalising pass is needed —
    // and a normalising pass would be actively wrong, because it would divide
    // the floors it had just created back down and quietly deliver less than
    // the 5% this whole mechanism is named after.
    for (const observed of [
      [0, 500, 999, 0, 5_000, 50_000],
      [0, 0, 0, 0, 0, 50_000],
      [null, null, null, null, null, null],
      [0, null, 1_000, null, 999, 50_000],
    ] as const) {
      const weights = sixWith(observed);
      expect(weights.reduce((sum, w) => sum + w.weight, 0)).toBeCloseTo(1, 9);
    }

    // The floor survives intact in the mixed case — the measurement a
    // renormalising implementation fails while still summing to 1.
    const mixed = sixWith([0, null, 1_000, null, 999, 50_000]);
    expect(weightOf(mixed, 'provider-a') - weightOf(mixed, 'provider-f')).toBeCloseTo(0.1 / 2, 9);
    expect(weightOf(mixed, 'provider-e') - weightOf(mixed, 'provider-f')).toBeCloseTo(0.1 / 2, 9);
  });

  it('lets a provider with a new binding reach 0.68, and says so', () => {
    // The consequence, asserted rather than left to be discovered: the 60% cap
    // now governs the EARNED share, not the total. A provider that dominates on
    // score AND holds every new binding reaches 0.6 × 0.8 + 0.2 = 0.68.
    //
    // That is the price of measuring a binding nobody knows anything about. It
    // is hard-capped by the 20% budget and it ends by itself at 1,000 calls.
    // The alternative — carving the floor out of that provider's own ≤60% —
    // gives a new binding from a capped provider almost nothing, which is no
    // floor exactly where one is needed.
    const newBinding = (id: string) =>
      buildCandidate('provider-a', { binding: { id }, provider: DOMINANT, observedCalls: 0 });

    const weights = computeWeights(
      scoreCandidates([
        newBinding('a-1'),
        newBinding('a-2'),
        newBinding('a-3'),
        newBinding('a-4'),
        buildCandidate('provider-b', { provider: BARELY_ALIVE, observedCalls: 50_000 }),
        buildCandidate('provider-c', { provider: BARELY_ALIVE, observedCalls: 50_000 }),
      ]),
    );

    const shareOf = (providerId: string) =>
      weights
        .filter((w) => w.candidate.binding.providerId === providerId)
        .reduce((sum, w) => sum + w.weight, 0);

    expect(shareOf('provider-a')).toBeCloseTo(0.68, 9);
    expect(shareOf('provider-a')).toBeGreaterThan(MAX_PROVIDER_SHARE);
    // And 0.68 is the ceiling, not a step on the way somewhere worse: the two
    // beaten providers still hold the rest between them.
    expect(shareOf('provider-b') + shareOf('provider-c')).toBeCloseTo(0.32, 9);
    expect(weights.reduce((sum, w) => sum + w.weight, 0)).toBeCloseTo(1, 9);
  });

  it('keeps both arities — computeWeights(scored) and computeWeights(scored, cap)', () => {
    // `select()` passes the configured cap; `quoteTool` passes one argument.
    // A signature that served only one of them would break the other, and both
    // call sites are on the path an agent is blocked on.
    //
    // Asymmetric scores on purpose: with three identical candidates every cap
    // produces the same thirds, so a cap that was accepted and then dropped
    // would go unnoticed.
    const exploring = (observedCalls: number) => [
      buildCandidate('provider-a', { provider: DOMINANT, observedCalls }),
      buildCandidate('provider-b', { provider: BARELY_ALIVE, observedCalls: 50_000 }),
      buildCandidate('provider-c', { provider: BARELY_ALIVE, observedCalls: 50_000 }),
    ];
    const scored = scoreCandidates(exploring(0));

    const defaulted = computeWeights(scored);
    const explicit = computeWeights(scored, MAX_PROVIDER_SHARE);
    expect(defaulted.map((w) => w.weight)).toEqual(explicit.map((w) => w.weight));

    // And the cap is genuinely threaded through to the base allocation rather
    // than being accepted and dropped: a tighter cap changes the answer.
    const tight = computeWeights(scored, 0.5);
    expect(tight.map((w) => w.weight)).not.toEqual(defaulted.map((w) => w.weight));
    expect(tight.reduce((sum, w) => sum + w.weight, 0)).toBeCloseTo(1, 9);

    // The floor rides on top of whatever cap was passed: A's earned share is
    // the tighter cap, scaled by the 0.95 that survives the reserve.
    const base = computeWeights(scoreCandidates(exploring(50_000)), 0.5);
    expect(weightOf(base, 'provider-a')).toBeCloseTo(0.5, 9);
    expect(weightOf(tight, 'provider-a')).toBeCloseTo(0.05 + 0.95 * 0.5, 9);
    expect(weightOf(tight, 'provider-b')).toBeCloseTo(0.95 * weightOf(base, 'provider-b'), 9);
  });

  it('leaves a candidate set with no exploring binding exactly as it was', () => {
    // Zero explorers must reserve zero — not "a tiny amount that rounds to
    // zero". Anything else would move traffic on a tool where nothing is new.
    const weights = sixWith([50_000, 50_000, 50_000, 50_000, 50_000, 50_000]);
    for (const id of IDS) {
      expect(weightOf(weights, id)).toBeCloseTo(SETTLED, 9);
    }
    expect(computeWeights([])).toEqual([]);
  });
});
