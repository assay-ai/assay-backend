import {
  DEFAULT_VERIFICATION_BUDGET,
  SampleRateBasis,
  SampleRateOverride,
  decideSampling,
  deriveSampleRate,
  describeSampleRate,
  sampleSelector,
  usdFromMoney,
} from '@modules/verification/domain';
import { toAssetId, toChainId } from '@modules/chains/ports/caip.types';
import { VerificationErrorCode } from '@modules/verification/errors/verification.errors';
import { BaseError } from '@shared/errors/base.error';
import { MoneyUtil } from '@shared/utils/money.util';

/**
 * The sampling half of the semantic verification stage.
 *
 * Two properties are asserted here and nowhere else, because nothing downstream
 * can recover them:
 *
 * 1. **The rate is derived, never chosen.** It falls out of the verification
 *    budget and the platform fee — change either and the rate moves with it.
 *    The published sampling-budget table is the source.
 * 2. **The selection is uniform and keyed.** A rate nobody honours is a
 *    decoration, so the empirical fraction over thousands of calls has to land
 *    on the target.
 */

const USDC = toAssetId(
  toChainId('solana', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'),
  'token',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
);

/** The doc's worked example: a $0.001 call at a 10% take rate. */
const FEE_ON_ONE_TENTH_CENT = 0.0001;

/** The domain error code a thrower raised, or `undefined` if it did not throw. */
function codeOf(act: () => unknown): string | undefined {
  try {
    act();
    return undefined;
  } catch (error) {
    return (error as BaseError).errorCode;
  }
}

describe('deriveSampleRate — the rate comes out of the budget, not a constant', () => {
  it('reproduces the published table, top to bottom', () => {
    // The sampling-budget table. Two
    // deliberate departures from the table's display column, both in `oneIn`
    // and neither in the rate:
    //
    //  - 8% is 1 in 12.5. The doc prints "1 in 12", which claims we check
    //    *more* often than we do; the code rounds the other way.
    //  - Above 50% the "1 in N" form stops meaning anything — 80% would print
    //    "1 in 1", which reads as every call. `oneIn` is null there and the
    //    percentage form is used instead.
    const table: readonly [number, number, number | null][] = [
      // [platform fee, expected rate, expected "1 in N"]
      [0.0001, 0.008, 125],
      [0.001, 0.08, 13],
      [0.01, 0.8, null],
      [0.1, 1, null],
    ];

    for (const [fee, expectedRate, expectedOneIn] of table) {
      const derived = deriveSampleRate({ platformFeeUsd: fee });
      expect(derived.rate).toBeCloseTo(expectedRate, 10);
      expect(derived.oneIn).toBe(expectedOneIn);
      expect(derived.basis).toBe(SampleRateBasis.BUDGET);
    }
  });

  it('scales with the tool price: ten times the fee, ten times the rate', () => {
    const cheap = deriveSampleRate({ platformFeeUsd: FEE_ON_ONE_TENTH_CENT });
    const dearer = deriveSampleRate({ platformFeeUsd: FEE_ON_ONE_TENTH_CENT * 10 });

    expect(dearer.rate).toBeCloseTo(cheap.rate * 10, 10);
  });

  it('scales with the budget ratio: double the budget, double the rate', () => {
    const standard = deriveSampleRate({ platformFeeUsd: FEE_ON_ONE_TENTH_CENT });
    const generous = deriveSampleRate({
      platformFeeUsd: FEE_ON_ONE_TENTH_CENT,
      budget: { ...DEFAULT_VERIFICATION_BUDGET, ratioOfFee: 0.4 },
    });

    expect(generous.rate).toBeCloseTo(standard.rate * 2, 10);
    expect(generous.budgetUsd).toBeCloseTo(standard.budgetUsd * 2, 10);
  });

  it('scales with what a judgement costs: a cheaper model verifies more calls', () => {
    const standard = deriveSampleRate({ platformFeeUsd: FEE_ON_ONE_TENTH_CENT });
    const cheaperModel = deriveSampleRate({
      platformFeeUsd: FEE_ON_ONE_TENTH_CENT,
      budget: { ...DEFAULT_VERIFICATION_BUDGET, semanticCostUsd: 0.00125 },
    });

    expect(cheaperModel.rate).toBeCloseTo(standard.rate * 2, 10);
  });

  it('never exceeds 1, however large the fee', () => {
    const derived = deriveSampleRate({ platformFeeUsd: 1_000 });

    expect(derived.rate).toBe(1);
    expect(derived.basis).toBe(SampleRateBasis.BUDGET);
  });

  it('is zero for a free call — there is no fee to spend a fraction of', () => {
    const derived = deriveSampleRate({ platformFeeUsd: 0 });

    expect(derived.rate).toBe(0);
    expect(derived.oneIn).toBeNull();
  });

  it('refuses a negative fee rather than inverting the rate', () => {
    expect(codeOf(() => deriveSampleRate({ platformFeeUsd: -0.01 }))).toBe(
      VerificationErrorCode.VERIFICATION_SAMPLE_RATE_UNDERIVABLE,
    );
  });

  it('refuses a budget whose judgement cost is zero', () => {
    expect(
      codeOf(() =>
        deriveSampleRate({
          platformFeeUsd: 0.01,
          budget: { ...DEFAULT_VERIFICATION_BUDGET, semanticCostUsd: 0 },
        }),
      ),
    ).toBe(VerificationErrorCode.VERIFICATION_SAMPLE_RATE_UNDERIVABLE);
  });
});

describe('deriveSampleRate — overrides', () => {
  it('lifts a new provider to every call, whatever the price', () => {
    const derived = deriveSampleRate({
      platformFeeUsd: FEE_ON_ONE_TENTH_CENT,
      overrides: [SampleRateOverride.NEW_PROVIDER],
    });

    expect(derived.rate).toBe(1);
    expect(derived.basis).toBe(SampleRateBasis.FLOOR);
    expect(derived.override).toBe(SampleRateOverride.NEW_PROVIDER);
  });

  /**
   * The sampling half of the explore/exploit rule.
   *
   * The explore/exploit rule gives a new binding two things together: 5% of
   * the tool's traffic, and 100% verification sampling for its first 1,000 calls. The traffic half is
   * `EXPLORATION_FLOOR_SHARE` in `domain/routing/weights.ts`; this is the unit
   * the sampling half was missing.
   *
   * The two cases below are the whole argument for a seventh member, and the
   * first one is the case `NEW_PROVIDER` gets wrong: a provider with two years
   * of history publishing a brand-new binding is *not* a new provider, and
   * under `NEW_PROVIDER` alone that binding would take exploration traffic
   * while being sampled at whatever its price bought — which is the expensive
   * direction, because the point of the floor is to BUY observations.
   */
  it('forces 100% for an exploring BINDING, even on an established provider', () => {
    // NEW_PROVIDER cannot express this — that is why the member exists.
    const rate = deriveSampleRate({
      platformFeeUsd: 0.01,
      overrides: [SampleRateOverride.EXPLORING_BINDING],
    });

    expect(rate.rate).toBe(1);
    expect(rate.basis).toBe('FLOOR');
    expect(rate.override).toBe(SampleRateOverride.EXPLORING_BINDING);
  });

  it('still yields to DAILY_COST_CAP_EXCEEDED', () => {
    // The cap outranks every floor, this one included. Exploration is the
    // platform choosing to spend; the cap is the platform having spent it.
    const rate = deriveSampleRate({
      platformFeeUsd: 0.01,
      overrides: [SampleRateOverride.EXPLORING_BINDING, SampleRateOverride.DAILY_COST_CAP_EXCEEDED],
    });

    expect(rate.rate).toBe(0);
    expect(rate.basis).toBe(SampleRateBasis.SUPPRESSED);
    expect(rate.override).toBe(SampleRateOverride.DAILY_COST_CAP_EXCEEDED);
  });

  it('halves the budget rate for a trusted provider', () => {
    const budgeted = deriveSampleRate({ platformFeeUsd: FEE_ON_ONE_TENTH_CENT });
    const trusted = deriveSampleRate({
      platformFeeUsd: FEE_ON_ONE_TENTH_CENT,
      overrides: [SampleRateOverride.TRUSTED_PROVIDER],
    });

    expect(trusted.rate).toBeCloseTo(budgeted.rate * 0.5, 10);
    expect(trusted.basis).toBe(SampleRateBasis.REDUCED);
    expect(trusted.oneIn).toBe(250);
  });

  it('gives a 100% floor precedence over the trusted discount', () => {
    const derived = deriveSampleRate({
      platformFeeUsd: FEE_ON_ONE_TENTH_CENT,
      overrides: [SampleRateOverride.TRUSTED_PROVIDER, SampleRateOverride.UNDER_INVESTIGATION],
    });

    expect(derived.rate).toBe(1);
    expect(derived.override).toBe(SampleRateOverride.UNDER_INVESTIGATION);
  });

  it('drops to zero when the daily cost cap is blown, outranking every floor', () => {
    const derived = deriveSampleRate({
      platformFeeUsd: 10,
      overrides: [SampleRateOverride.GUARANTEED_TIER, SampleRateOverride.DAILY_COST_CAP_EXCEEDED],
    });

    expect(derived.rate).toBe(0);
    expect(derived.basis).toBe(SampleRateBasis.SUPPRESSED);
    expect(derived.override).toBe(SampleRateOverride.DAILY_COST_CAP_EXCEEDED);
  });
});

describe('describeSampleRate — what the receipt prints', () => {
  it('says "1 in 125 calls at this price" at a tenth of a cent', () => {
    const derived = deriveSampleRate({ platformFeeUsd: FEE_ON_ONE_TENTH_CENT });

    expect(describeSampleRate(derived)).toBe('1 in 125 calls at this price');
  });

  it('says "every call" at 100%', () => {
    expect(describeSampleRate(deriveSampleRate({ platformFeeUsd: 1 }))).toBe('every call');
  });

  it('switches to a percentage above half, where "1 in N" would read as every call', () => {
    expect(describeSampleRate(deriveSampleRate({ platformFeeUsd: 0.01 }))).toBe(
      '80% of calls at this price',
    );
  });

  it('says so plainly when nothing is sampled', () => {
    expect(describeSampleRate(deriveSampleRate({ platformFeeUsd: 0 }))).toBe(
      'no calls at this price',
    );
  });
});

describe('usdFromMoney', () => {
  it('converts atomic USDC units to the dollars the budget rule is written in', () => {
    expect(usdFromMoney(MoneyUtil.of('100', USDC, 6))).toBeCloseTo(0.0001, 10);
    expect(usdFromMoney(MoneyUtil.of('1000000', USDC, 6))).toBeCloseTo(1, 10);
  });

  it('makes the doc table reachable from a real fee amount', () => {
    const fee = MoneyUtil.of('100', USDC, 6);

    expect(deriveSampleRate({ platformFeeUsd: usdFromMoney(fee) }).oneIn).toBe(125);
  });
});

describe('decideSampling — keyed, uniform, and decided after the response', () => {
  const SECRET = 'test-sampling-secret';

  it('selects the same call the same way every time', () => {
    const rate = deriveSampleRate({ platformFeeUsd: 0.001 });
    const first = decideSampling({ secret: SECRET, intentId: 'pi_abc123', rate });
    const second = decideSampling({ secret: SECRET, intentId: 'pi_abc123', rate });

    expect(second).toEqual(first);
  });

  it('selects differently under a different secret — the provider cannot predict it', () => {
    const rate = deriveSampleRate({ platformFeeUsd: 0.001 });
    const ours = sampleSelector(SECRET, 'pi_abc123');
    const theirs = sampleSelector('a-different-secret', 'pi_abc123');

    expect(ours).not.toBeCloseTo(theirs, 6);
    expect(rate.rate).toBeGreaterThan(0);
  });

  it('always samples at 100% and never samples at 0%', () => {
    const everything = deriveSampleRate({ platformFeeUsd: 1 });
    const nothing = deriveSampleRate({ platformFeeUsd: 0 });

    for (let index = 0; index < 200; index += 1) {
      const intentId = `pi_${index}`;
      expect(decideSampling({ secret: SECRET, intentId, rate: everything }).sampled).toBe(true);
      expect(decideSampling({ secret: SECRET, intentId, rate: nothing }).sampled).toBe(false);
    }
  });

  it('hits the target fraction over 20,000 simulated calls, at both ends of the table', () => {
    const cases = [
      { fee: 0.0001, expected: 0.008 },
      { fee: 0.001, expected: 0.08 },
      { fee: 0.01, expected: 0.8 },
    ];

    for (const { fee, expected } of cases) {
      const rate = deriveSampleRate({ platformFeeUsd: fee });
      const calls = 20_000;
      let sampled = 0;

      for (let index = 0; index < calls; index += 1) {
        if (decideSampling({ secret: SECRET, intentId: `pi_${index}`, rate }).sampled) {
          sampled += 1;
        }
      }

      // Four standard errors of a binomial proportion. Wide enough that a
      // correct sampler cannot trip it, narrow enough that a sampler off by a
      // factor of two cannot hide in it — and deterministic, because the
      // selector is an HMAC rather than a PRNG.
      const tolerance = 4 * Math.sqrt((expected * (1 - expected)) / calls);
      expect(Math.abs(sampled / calls - expected)).toBeLessThan(tolerance);
    }
  });

  it('carries the rate it decided on, for the receipt', () => {
    const rate = deriveSampleRate({ platformFeeUsd: FEE_ON_ONE_TENTH_CENT });
    const decision = decideSampling({ secret: SECRET, intentId: 'pi_abc123', rate });

    expect(decision.rate).toEqual(rate);
    expect(decision.selector).toBeGreaterThanOrEqual(0);
    expect(decision.selector).toBeLessThan(1);
  });
});
