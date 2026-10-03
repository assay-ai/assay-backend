/**
 * The verdict vocabulary.
 *
 * A verdict is not a grade. It is an *attribution* plus a settlement
 * instruction, in the same sense as `ResponseClass` next door in the response
 * classifier — and for the same reason: the value is read by code that moves
 * money, so the set of values has to be exactly as wide as the set of things
 * that can actually happen. Every fact the vocabulary cannot express collapses
 * into the nearest value that can, and in a two-value vocabulary that value is
 * always `FAIL`.
 *
 * The requirement is to *"stop the obviously-wrong FAIL"*. Two of them are
 * obvious enough to name here:
 *
 * ```text
 * search_web("a genuinely unindexed string") → {"results": []}
 *     narrow vocabulary → MIN_ARRAY_LENGTH fails → FAIL → strike
 *     the provider answered correctly. There was nothing to return.
 *
 * search_web("balance of 7xKX…vault")        → correct web results
 *     narrow vocabulary → the check does not fit the request → FAIL → strike
 *     the provider answered correctly. The check was pointed at the wrong thing.
 * ```
 *
 * `EMPTY_CONFIRMED` and `MISAPPLIED` exist so neither of those reaches a
 * provider's stake. The short form of the argument is that a false positive
 * costs an honest provider money and there is no refund for the reputation that
 * goes with it, while a false negative costs us one quality signal out of
 * thousands.
 */

// Type-only, and it has to stay that way: `./stage.ts` imports `VerdictStatus`
// back from here. Both directions are erased at compile time, so the cycle
// exists in the type graph and never in the module graph — which is what lets
// the two halves of the vocabulary reference each other without either file
// having to describe the other's types second-hand.
import type { SampleRate } from './sampling';
import type { SemanticContext } from './semantic.types';
import type { StageResult } from './stage';

/**
 * The outcome of verification for one call.
 *
 * Four of these are the original verification vocabulary; the other three were
 * added later, and each one is a distinct answer to "who, if anyone, got this
 * wrong".
 */
export enum VerdictStatus {
  /** Met the policy. Provider credited, agent charged. */
  PASS = 'PASS',

  /**
   * The response provably did not honour the tool contract, and the provider is
   * the party that failed to honour it.
   *
   * The **only** status that records a strike, and therefore the only road to a
   * slash. Everything ambiguous resolves away from here.
   */
  FAIL = 'FAIL',

  /**
   * The result set was empty, and something independent corroborates that empty
   * is the correct answer.
   *
   * Passing. A provider whose coverage is narrow and honest must not score
   * worse than one that pads results — that inversion is the exact opposite of
   * what the product sells.
   */
  EMPTY_CONFIRMED = 'EMPTY_CONFIRMED',

  /**
   * The result set was empty and nothing corroborated it, because no second
   * source was consulted.
   *
   * Also passing, and deliberately *named differently* from
   * {@link EMPTY_CONFIRMED}. Both credit the provider, so the distinction buys
   * nothing at settlement — it buys honesty on the receipt and a metric that
   * says how often we are paying without evidence. Cross-check is what
   * converts these into confirmed ones.
   */
  EMPTY_UNVERIFIED = 'EMPTY_UNVERIFIED',

  /**
   * The check did not fit what was being checked.
   *
   * Two shapes, one attribution — *not the provider's*:
   *
   * - The policy is pointed at a field, a type or a shape the response never
   *   claimed to have. A rule that asks the freshness of a string is a policy
   *   bug, and a policy bug that fails providers is the highest-risk deploy in
   *   the system.
   * - The request was outside the tool's scope, so a well-formed and responsive
   *   answer still fails a relevance judgement. That half is produced by the
   *   semantic stage.
   *
   * Settles as `VOIDED`: agent not charged, provider not credited, **no
   * strike**. It feeds `misapplication_rate` keyed on `(tool, agent)`, which is
   * a product signal — a rising rate means a tool description or a policy is
   * bad, not that a provider is.
   */
  MISAPPLIED = 'MISAPPLIED',

  /**
   * The cheap stages passed and an expensive stage was unavailable.
   *
   * Credits the provider. Unavailability of our own infrastructure must not
   * become a provider's loss. Produced by the semantic stage; here so the table
   * is whole.
   */
  DEGRADED = 'DEGRADED',

  /**
   * The sampled stages were not selected for this call.
   *
   * Credits the provider. Note that this can never describe the schema or
   * deterministic stages — those run on every call, unsampled.
   */
  SKIPPED = 'SKIPPED',
}

/**
 * What a verdict does to the payment intent and to the provider.
 *
 * Named terminal states rather than the `PaymentIntentStatus` enum: this table
 * is the *decision*, and the payment module owns *applying* it. Importing the
 * status enum here would make the verification domain depend on the payment
 * domain to express a judgement that does not need it.
 */
export enum VerdictOutcome {
  /** Commit the hold. Provider credited, agent charged. */
  SETTLE = 'SETTLE',
  /** Release the hold **and** record a strike. The provider got it wrong. */
  REFUND = 'REFUND',
  /** Release the hold, record nothing. Nobody got it wrong, or we did. */
  VOID = 'VOID',
}

export interface VerdictConsequence {
  readonly outcome: VerdictOutcome;
  /** Is the agent charged and the provider credited? */
  readonly settle: boolean;
  /** Does this record a strike against the provider? */
  readonly strike: boolean;
  /** Can this, through any downstream path, reach the provider's stake? */
  readonly slashable: boolean;
  /** Which metric it moves. `null` where it moves none. */
  readonly metric: 'quality' | 'coverage' | 'misapplication' | 'availability' | null;
}

/**
 * The settlement table, as data.
 *
 * A reviewer should be able to read the invariant off this object in one pass,
 * and `test/unit/verification/verdict-vocabulary.spec.ts` asserts it rather
 * than trusting them to: **exactly one status is slashable, and it is the one
 * that also strikes.** Everything else either pays the provider or voids the
 * call. That is the "default is to pay" rule, written where it can be tested.
 */
export const VERDICT_CONSEQUENCE: Readonly<Record<VerdictStatus, VerdictConsequence>> =
  Object.freeze({
    [VerdictStatus.PASS]: Object.freeze({
      outcome: VerdictOutcome.SETTLE,
      settle: true,
      strike: false,
      slashable: false,
      metric: 'quality',
    }),
    [VerdictStatus.FAIL]: Object.freeze({
      outcome: VerdictOutcome.REFUND,
      settle: false,
      strike: true,
      slashable: true,
      metric: 'quality',
    }),
    [VerdictStatus.EMPTY_CONFIRMED]: Object.freeze({
      outcome: VerdictOutcome.SETTLE,
      settle: true,
      strike: false,
      slashable: false,
      metric: 'coverage',
    }),
    [VerdictStatus.EMPTY_UNVERIFIED]: Object.freeze({
      outcome: VerdictOutcome.SETTLE,
      settle: true,
      strike: false,
      slashable: false,
      metric: 'coverage',
    }),
    [VerdictStatus.MISAPPLIED]: Object.freeze({
      outcome: VerdictOutcome.VOID,
      settle: false,
      strike: false,
      slashable: false,
      metric: 'misapplication',
    }),
    [VerdictStatus.DEGRADED]: Object.freeze({
      outcome: VerdictOutcome.SETTLE,
      settle: true,
      strike: false,
      slashable: false,
      metric: 'availability',
    }),
    [VerdictStatus.SKIPPED]: Object.freeze({
      outcome: VerdictOutcome.SETTLE,
      settle: true,
      strike: false,
      slashable: false,
      metric: null,
    }),
  } as const);

/**
 * The one-line form of the rule, for call sites.
 *
 * Call this rather than writing `status === VerdictStatus.FAIL` by hand: a
 * comparison against one member is a rule that silently stops being true the
 * day an eighth status exists, and the eighth status (`PARTIAL_RESULT`,
 * `UPSTREAM_INDUCED`, `DEFERRED` are all candidates) is a matter of when.
 */
export function isProviderAtFault(status: VerdictStatus): boolean {
  return VERDICT_CONSEQUENCE[status].strike;
}

/** Does this verdict credit the provider and charge the agent? */
export function creditsProvider(status: VerdictStatus): boolean {
  return VERDICT_CONSEQUENCE[status].settle;
}

/**
 * One call's judgement.
 *
 * `stages` carries **one entry per pipeline stage, always**, in pipeline order
 * — including the stages that never ran. A receipt that silently omits the
 * stages after a failure reads as though they were fine; see
 * {@link ./stage.ts} for why that omission is a money-losing bug rather than a
 * cosmetic one.
 */
export interface Verdict {
  readonly intentId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly status: VerdictStatus;
  /**
   * The aggregate score, `0..1`, or `null` when no stage produced one.
   *
   * `null` rather than `0` when nothing scored. A zero is a judgement; the
   * absence of a judgement is not, and a receipt showing "score 0.00" for a
   * call that was never scored is the same lie as a stage showing "passed" for
   * a stage that never ran.
   */
  readonly score: number | null;
  readonly stages: readonly StageResult[];
  /** Machine-readable, stable, and what metrics group by. */
  readonly reasonCode: string | null;
  /** One human sentence. What the receipt prints under the failing stage. */
  readonly reason: string | null;
  /**
   * Was the sampled stage actually drawn for this call?
   *
   * Only the semantic stage is sampled — the two cheap layers run on every
   * call — so this says whether a model judged the response. `false`
   * covers three different situations, which is why it is never the whole
   * story on a receipt: not drawn, not reached, or no policy asked for it.
   */
  readonly sampled: boolean;
  /**
   * The odds this call had of being judged, and why they were what they were.
   *
   * The rate is public — the receipt says *1 in 125 calls at
   * this price* rather than leaving an agent to infer that a cheap call was
   * checked as thoroughly as an expensive one. `null` when the semantic stage
   * was never reached or the policy never declared it, since there were no odds
   * to publish.
   */
  readonly sampleRate: SampleRate | null;
  /**
   * What produced the relevance judgement, pinned.
   *
   * `null` unless a model actually judged this call. When it is not null, the
   * verdict can be re-derived: same model snapshot, same prompt version, same
   * prompt hash, same truncation bound, temperature 0. That property is what
   * makes a verdict usable as evidence for a slash — see
   * `domain/semantic-context.ts`, which refuses to build one that lacks it.
   */
  readonly semanticContext: SemanticContext | null;
  /**
   * The policy was in `SHADOW`, so this verdict has no economic effect
   * regardless of its status. See {@link effectiveConsequence}.
   */
  readonly shadow: boolean;
  /** What producing this verdict cost. Zero for the two cheap stages. */
  readonly costUsd: number;
  readonly evaluatedAt: Date;
}

/**
 * What this verdict is actually allowed to do.
 *
 * A `SHADOW` policy computes verdicts and records them and changes nothing —
 * that is the whole mechanism, and it is mandatory rather than advisory,
 * because a bad rule reaching production slashes honest providers before anyone
 * notices. Enforcing it *here*, at the point where a status becomes an
 * instruction, means no call site can forget: a shadow verdict of any status
 * yields the `PASS` consequence, which pays.
 */
export function effectiveConsequence(verdict: {
  readonly status: VerdictStatus;
  readonly shadow: boolean;
}): VerdictConsequence {
  return verdict.shadow
    ? VERDICT_CONSEQUENCE[VerdictStatus.PASS]
    : VERDICT_CONSEQUENCE[verdict.status];
}
