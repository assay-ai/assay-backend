/**
 * The sampling budget.
 *
 * One semantic judgement costs about 2.5× a $0.001 API call, so verifying every
 * call at the cheap end is arithmetically impossible. The response is *not* a
 * hand-tuned rate per tool — it is a rate **derived** from the fee:
 *
 * ```text
 * budget  = ratioOfFee × platformFee        20% of what we earned on the call
 * rate    = min(1, budget / judgementCost)  how much of a judgement that buys
 * ```
 *
 * | Price | Fee (example: 10%) | Budget | Rate | Effect |
 * |---|---|---|---|---|
 * | $0.001 | $0.0001 | $0.00002 | 0.8% | 1 in 125 calls |
 * | $0.01 | $0.001 | $0.0002 | 8% | 1 in 12 |
 * | $0.10 | $0.010 | $0.0020 | 80% | 4 in 5 |
 * | $1.00 | $0.100 | $0.0200 | 100% | every call |
 *
 * Expensive calls are verified thoroughly, cheap calls are sampled, nobody
 * tunes anything, and the verification cost stays a fixed share of revenue
 * across four orders of magnitude of price. The constants are the two numbers
 * the derivation rests on and they are inputs, not literals buried in a
 * function: change the model and `semanticCostUsd` moves, change the margin and
 * `ratioOfFee` moves, and every rate in the system moves with them.
 *
 * ## Selection is keyed, not random
 *
 * A provider able to tell which calls are verified would serve good data only
 * for those, and the whole layer would be theatre. Three properties prevent it,
 * and the third is the one implemented here:
 *
 * - **Decided after the response.** Nothing in the request distinguishes a
 *   sampled call — the caller runs the cheap stages first and only then asks.
 * - **Out of band.** The judgement runs in a worker; the provider sees no
 *   second request.
 * - **Keyed.** The selector is `HMAC-SHA256(secret, intentId)`, not
 *   `Math.random()`. Unpredictable without the key, uniform on `[0, 1)`, and —
 *   unlike a PRNG — **reproducible**, which is what lets an evidence pack prove
 *   *this call was in the sample* months later rather than asserting it. The
 *   evidence pack's "sample-selection proof" is exactly this value.
 */

import { Money } from '@modules/chains/ports/money.types';
import { createHmac } from 'crypto';
import { VerificationErrors } from '../errors/verification.errors';

/**
 * What the platform will spend judging a call, as a share of what it earned.
 *
 * Both members are per-deployment facts rather than universal ones, which is
 * why they travel together in a value a caller can override in one place.
 */
export interface VerificationBudget {
  /** Share of the platform fee available for semantic judgement. */
  readonly ratioOfFee: number;
  /** What one judgement costs, all-in. */
  readonly semanticCostUsd: number;
}

/** The two published constants. */
export const DEFAULT_VERIFICATION_BUDGET: VerificationBudget = Object.freeze({
  ratioOfFee: 0.2,
  semanticCostUsd: 0.0025,
});

/**
 * Why the rate is what it is — the receipt's and the console's explanation.
 *
 * Kept separate from the number because "8% because that is what the fee buys"
 * and "8% because a trusted provider earned a discount off 16%" are different
 * facts about the same rate, and only one of them changes when the price does.
 */
export enum SampleRateBasis {
  /** Straight from the budget rule. The usual case. */
  BUDGET = 'BUDGET',
  /** An override raised it to every call. */
  FLOOR = 'FLOOR',
  /** An override cut the budget rate. */
  REDUCED = 'REDUCED',
  /** An override took it to zero. */
  SUPPRESSED = 'SUPPRESSED',
}

/**
 * The conditions that overrule the budget.
 *
 * Precedence is fixed and is asserted in the suite, because two of these
 * conflict on purpose: a `GUARANTEED_TIER` tool whose daily cost cap has blown
 * is both "always verify" and "stop spending". The cap wins — the rule is
 * *degrade the guarantee rather than burn the margin silently*, and an alert
 * fires. A cap that could be overruled by the very tool that blew it is not a
 * circuit breaker.
 */
export enum SampleRateOverride {
  /** Per-tool daily verification spend exceeded. Sampling stops. Highest precedence. */
  DAILY_COST_CAP_EXCEEDED = 'DAILY_COST_CAP_EXCEEDED',
  /** No history to rely on. The platform pays for the confidence. */
  NEW_PROVIDER = 'NEW_PROVIDER',
  /**
   * A binding inside its exploration window — its first 1,000 calls.
   *
   * The sampling half of the explore/exploit rule, whose other half is
   * `EXPLORATION_FLOOR_SHARE` in `modules/tool/domain/routing/weights.ts`. The
   * rule gives a new binding both
   * at once — 5% of the tool's traffic *and* 100% verification sampling — and
   * they are one rule: the floor exists to **buy observations**, and traffic
   * routed to a binding nobody verifies buys none.
   *
   * **Per binding, which is why {@link NEW_PROVIDER} could not carry it.** A
   * provider with two years of history publishing a brand-new binding is not a
   * new provider, and that is precisely the case this exists for — the
   * mappings, the endpoint and the price are all unobserved however long the
   * company has been here. `isExploring()` in `weights.ts` is the predicate,
   * and it is exported so that the two halves of the rule cannot drift about
   * which bindings are still new.
   *
   * **Nothing produces it yet.** `deriveSampleRate`'s production caller —
   * `verification-settlement.service.ts`, in `judge()` — passes no `overrides`
   * at all, so this member is vocabulary waiting for the line that threads a
   * binding's observed-call count into that call. Until then the explore/exploit
   * rule runs on its traffic half alone.
   */
  EXPLORING_BINDING = 'EXPLORING_BINDING',
  /** What the `guaranteed` tier buys. */
  GUARANTEED_TIER = 'GUARANTEED_TIER',
  /** Building an evidence pack for a dispute. */
  UNDER_INVESTIGATION = 'UNDER_INVESTIGATION',
  /** A call with a known expected answer, indistinguishable from real traffic. */
  CANARY = 'CANARY',
  /** Earned reduction: half the budget rate. */
  TRUSTED_PROVIDER = 'TRUSTED_PROVIDER',
}

/**
 * The overrides that force every call, in precedence order after the cap.
 *
 * Every member here yields the same rate — 1 — so the order decides only which
 * reason a receipt prints when two of them are true of one call. Exploration
 * leads because it is the reason the call exists at all: the router sent it
 * under the exploration floor, and `EXPLORATION_BUDGET` in `weights.ts` is a
 * cost ceiling on this sampling as much as a traffic one. An investigation of a
 * binding still inside its first 1,000 calls is a second reason for the same
 * 100%, not a different one.
 */
const FLOOR_OVERRIDES: readonly SampleRateOverride[] = Object.freeze([
  SampleRateOverride.EXPLORING_BINDING,
  SampleRateOverride.UNDER_INVESTIGATION,
  SampleRateOverride.CANARY,
  SampleRateOverride.NEW_PROVIDER,
  SampleRateOverride.GUARANTEED_TIER,
]);

const TRUSTED_PROVIDER_MULTIPLIER = 0.5;

/**
 * The highest rate still expressible as "1 in N".
 *
 * Above a half the form collapses: 0.8 rounds to *1 in 1*, which says every
 * call. See {@link SampleRate.oneIn}.
 */
const ONE_IN_N_CEILING = 0.5;

/**
 * A derived rate, with everything a receipt needs to explain it.
 *
 * The whole object is what gets stored on a verdict, not the bare number: a
 * dispute months later asks *what were the odds this call was checked, and
 * why*, and a lone `0.008` cannot answer the second half.
 */
export interface SampleRate {
  /** `0..1`. The probability this call is judged. */
  readonly rate: number;
  /**
   * The rate as "1 in N", for display. `null` when the form does not apply.
   *
   * Precomputed rather than left to each surface, so the receipt, the console
   * and the provider dashboard cannot round it three different ways and show a
   * provider three different numbers for one call.
   *
   * Two cases have no honest "1 in N": a rate of zero, and any rate above a
   * half — 80% would print *1 in 1*, which reads as every call and is the exact
   * misunderstanding the published rate exists to prevent. Rounding is **up**
   * where it is not exact, so 8% shows as 1 in 13 rather than the table's 1
   * in 12: the true figure is 1 in 12.5, and the displayed number should never
   * claim we check more often than we do.
   */
  readonly oneIn: number | null;
  /** What the budget rule made available for this call, in USD. */
  readonly budgetUsd: number;
  readonly basis: SampleRateBasis;
  /** The override that moved it, or `null` when the budget stood. */
  readonly override: SampleRateOverride | null;
}

export interface DeriveSampleRateInput {
  /**
   * The platform fee on this call, in USD.
   *
   * A `number`, and the one place in this codebase where money is one — see
   * {@link usdFromMoney}. It is an input to a probability, never to a balance.
   */
  readonly platformFeeUsd: number;
  readonly budget?: VerificationBudget;
  readonly overrides?: readonly SampleRateOverride[];
}

export function deriveSampleRate(input: DeriveSampleRateInput): SampleRate {
  const budget = input.budget ?? DEFAULT_VERIFICATION_BUDGET;
  const { platformFeeUsd } = input;
  const overrides = input.overrides ?? [];

  if (!Number.isFinite(platformFeeUsd) || platformFeeUsd < 0) {
    throw VerificationErrors.sampleRateUnderivable({
      reason: 'platform fee is not a non-negative finite amount',
      platformFeeUsd,
    });
  }
  if (!Number.isFinite(budget.semanticCostUsd) || budget.semanticCostUsd <= 0) {
    throw VerificationErrors.sampleRateUnderivable({
      reason: 'a judgement cost of zero would make every rate infinite',
      semanticCostUsd: budget.semanticCostUsd,
    });
  }
  if (!Number.isFinite(budget.ratioOfFee) || budget.ratioOfFee < 0) {
    throw VerificationErrors.sampleRateUnderivable({
      reason: 'budget ratio is not a non-negative finite fraction',
      ratioOfFee: budget.ratioOfFee,
    });
  }

  const budgetUsd = budget.ratioOfFee * platformFeeUsd;
  const budgetRate = Math.min(1, budgetUsd / budget.semanticCostUsd);

  if (overrides.includes(SampleRateOverride.DAILY_COST_CAP_EXCEEDED)) {
    return rate(
      0,
      budgetUsd,
      SampleRateBasis.SUPPRESSED,
      SampleRateOverride.DAILY_COST_CAP_EXCEEDED,
    );
  }

  const floor = FLOOR_OVERRIDES.find((candidate) => overrides.includes(candidate));
  if (floor) {
    return rate(1, budgetUsd, SampleRateBasis.FLOOR, floor);
  }

  if (overrides.includes(SampleRateOverride.TRUSTED_PROVIDER)) {
    return rate(
      budgetRate * TRUSTED_PROVIDER_MULTIPLIER,
      budgetUsd,
      SampleRateBasis.REDUCED,
      SampleRateOverride.TRUSTED_PROVIDER,
    );
  }

  return rate(budgetRate, budgetUsd, SampleRateBasis.BUDGET, null);
}

function rate(
  value: number,
  budgetUsd: number,
  basis: SampleRateBasis,
  override: SampleRateOverride | null,
): SampleRate {
  return Object.freeze({
    rate: value,
    oneIn: value > 0 && value <= ONE_IN_N_CEILING ? Math.ceil(1 / value) : null,
    budgetUsd,
    basis,
    override,
  });
}

/**
 * The sentence a receipt prints under the relevance row.
 *
 * The rate is public — *"The sampling rate is public on the receipt"* — and one
 * wording lives here so the agent receipt, the provider dashboard and the
 * console cannot each invent their own.
 */
export function describeSampleRate(sampleRate: SampleRate): string {
  if (sampleRate.rate >= 1) return 'every call';
  if (sampleRate.rate <= 0) return 'no calls at this price';
  if (sampleRate.oneIn === null) {
    return `${Math.round(sampleRate.rate * 100)}% of calls at this price`;
  }
  return `1 in ${sampleRate.oneIn} calls at this price`;
}

/**
 * A `Money` fee as a USD `number`, for the budget arithmetic only.
 *
 * `Money` is an integer count of atomic units precisely so that money is never
 * a double (`money.types.ts`), and this function deliberately breaks that rule
 * in the one place where the output is a *probability*: nothing downstream of
 * it is credited, debited or settled, and a rate that is off by a float ulp
 * samples one call in 125.0000000001 instead of 125.
 *
 * It assumes the fee is denominated in a USD-pegged asset, which every MVP rail
 * is (USDC). A non-pegged asset would need a price oracle, and the honest place
 * for that is the caller — this function would silently treat 1 BONK as $1.
 */
export function usdFromMoney(fee: Money): number {
  return Number(fee.amount) / 10 ** fee.decimals;
}

/** A sampling decision, and the proof of how it was reached. */
export interface SamplingDecision {
  readonly sampled: boolean;
  readonly rate: SampleRate;
  /**
   * The keyed draw, `[0, 1)`. Sampled when it lands below the rate.
   *
   * Recorded because it is the audit: given the secret, anyone holding the
   * evidence pack can recompute it from the intent id and confirm that a call
   * we say was sampled actually was — and, more usefully to a provider
   * disputing a window, that calls we say were *not* sampled were not
   * cherry-picked.
   */
  readonly selector: number;
}

export interface SamplingInput {
  /**
   * The platform's sampling key. Never derived from anything the provider sees.
   *
   * Rotating it re-randomises which calls get sampled and invalidates the
   * reproducibility of older selections, so it is versioned with the evidence
   * it proves rather than rotated casually.
   */
  readonly secret: string;
  /** The call being judged. Unique per call, which is what makes the draw independent. */
  readonly intentId: string;
  readonly rate: SampleRate;
}

export function decideSampling(input: SamplingInput): SamplingDecision {
  const selector = sampleSelector(input.secret, input.intentId);

  return Object.freeze({
    // Strict `<` on a selector that is strictly below 1 gives both endpoints
    // exactly: rate 1 samples everything, rate 0 samples nothing.
    sampled: selector < input.rate.rate,
    rate: input.rate,
    selector,
  });
}

/**
 * A uniform draw on `[0, 1)`, keyed by the platform secret and the intent id.
 *
 * The first 52 bits of the HMAC, scaled — 52 because that is the mantissa of a
 * double, so every value is exactly representable and the mapping stays
 * uniform. Taking 64 bits and dividing would round some draws to exactly 1.0,
 * which is the one value that must never appear: at `rate = 1` it would make
 * `selector < rate` false and skip a call the caller demanded be verified.
 */
export function sampleSelector(secret: string, intentId: string): number {
  const digest = createHmac('sha256', secret).update(intentId).digest();
  // 52 bits: the high 32 shifted up, plus the next 20.
  const high = digest.readUInt32BE(0);
  const low = digest.readUInt32BE(4) >>> 12;

  return (high * 2 ** 20 + low) / 2 ** 52;
}
