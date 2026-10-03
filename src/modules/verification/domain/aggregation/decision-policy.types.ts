/**
 * The decision policy — how votes become a verdict.
 *
 * A `VerificationPolicy` (`../policy.types.ts`) says *what to check*. A
 * `DecisionPolicy` says *what a pattern of results means*. They are separate
 * documents because they change for opposite reasons and at opposite risk: a
 * new rule is additive and its blast radius is one tool, while a change to the
 * aggregation rule reinterprets every verdict that policy produces. Keeping
 * them in one blob would mean every rule tweak re-versions the thing that
 * decides who gets slashed.
 *
 * The rule language is an **ordered list of clauses, first match wins**, and
 * that shape is chosen over an expression tree deliberately. A tree is more
 * expressive and strictly worse here: the property an on-call engineer needs at
 * 3am is *"read the policy top to bottom and know what fires"*, and the
 * property aggregation needs is that a clause can be shown, in a receipt, as
 * the one sentence that decided the call. The canonical example — `2/4 → FAIL`
 * — is one clause.
 *
 * ```jsonc
 * {
 *   "id": "search_web.default", "version": 3, "toolId": "…",
 *   "verifiers": [
 *     { "verifierId": "schema" }, { "verifierId": "rules" },
 *     { "verifierId": "cross_check" }, { "verifierId": "semantic" }
 *   ],
 *   "clauses": [
 *     { "when": "VERIFIER_FAILED",   "verifierId": "schema", "then": "FAIL",
 *       "label": "a response that is not the declared shape is not the product" },
 *     { "when": "MISAPPLIED_AT_LEAST", "count": 1, "then": "MISAPPLIED" },
 *     { "when": "FAILURES_AT_LEAST", "count": 2, "then": "FAIL",
 *       "label": "2 of 4 verifiers disagreed with the response" },
 *     { "when": "VOTES_BELOW",       "count": 2, "then": "DEGRADED" }
 *   ],
 *   "otherwise": "PASS"
 * }
 * ```
 */

import { VerdictStatus } from '../verdict';

/**
 * Where a policy version is in its life.
 *
 * The promote gate is the edge `SHADOW → ACTIVE`, and it is the only
 * edge that changes whether anybody can lose money. Every other state either
 * cannot serve traffic at all or serves it inertly.
 */
export enum PolicyLifecycle {
  /** Being authored. Never resolved for traffic, not even in shadow. */
  DRAFT = 'DRAFT',
  /**
   * Serving real traffic with **no economic effect**.
   *
   * This state is mandatory rather than advisory: verdicts are computed and
   * recorded against live calls, which is the only way to measure a
   * false-positive rate against real responses, and nobody is charged or struck
   * for any of them.
   */
  SHADOW = 'SHADOW',
  /** Through the promote gate. Verdicts settle. */
  ACTIVE = 'ACTIVE',
  /**
   * Pulled by the kill switch.
   *
   * Reached without a deploy and, unlike `ARCHIVED`, reversible — the operator
   * who pulled it is expected to put it back once the bad rule is understood.
   */
  WITHDRAWN = 'WITHDRAWN',
  /** Superseded by a later version. Kept for replaying old verdicts. */
  ARCHIVED = 'ARCHIVED',
}

/** Lifecycles that may be resolved for a live call at all. */
export const SERVING_LIFECYCLES: readonly PolicyLifecycle[] = Object.freeze([
  PolicyLifecycle.SHADOW,
  PolicyLifecycle.ACTIVE,
]);

/**
 * Does a verdict under this lifecycle move money?
 *
 * **Exactly one lifecycle enforces**, and this function is the only place that
 * fact is written. A stored `mode` column is deliberately *not* consulted
 * anywhere: the promote gate is worth nothing if an unpromoted policy can
 * declare itself `ACTIVE` in its own document. The lifecycle is set by the
 * gate; the document has no say.
 */
export function enforces(lifecycle: PolicyLifecycle): boolean {
  return lifecycle === PolicyLifecycle.ACTIVE;
}

export enum DecisionTrigger {
  /**
   * At least `count` verifiers voted `FAIL`.
   *
   * The worked example — `{ count: 2, then: FAIL }` is "if 2 of 4 fail,
   * then FAIL". An absolute count rather than a fraction because that is how the
   * requirement is stated and how an operator reasons about it; the fraction
   * form exists next door for policies with a variable verifier set.
   */
  FAILURES_AT_LEAST = 'FAILURES_AT_LEAST',
  /** At least this share of the *voting* verifiers failed. `0..1`, inclusive. */
  FAILED_FRACTION_AT_LEAST = 'FAILED_FRACTION_AT_LEAST',
  /**
   * One named verifier failed — a veto.
   *
   * For checks where a single failure is conclusive regardless of what the
   * others thought: a response that does not parse against the declared schema
   * is not the product the agent bought, and three verifiers liking it does not
   * change that.
   */
  VERIFIER_FAILED = 'VERIFIER_FAILED',
  /**
   * At least `count` verifiers reported `MISAPPLIED`.
   *
   * Almost always `count: 1` and placed *above* the failure clauses. A check
   * that did not fit is evidence our policy is wrong, and a policy that is
   * wrong about one verifier has not earned the right to strike a provider on
   * the strength of another.
   */
  MISAPPLIED_AT_LEAST = 'MISAPPLIED_AT_LEAST',
  /**
   * Fewer than `count` verifiers expressed an opinion at all.
   *
   * The participation floor. Without it a policy that reads "2 of 4 fail" is
   * satisfied by "2 voted, both failed, the other two timed out" — a coin flip
   * dressed as a quorum. Pair it with `then: DEGRADED`, which pays.
   */
  VOTES_BELOW = 'VOTES_BELOW',
}

interface DecisionClauseBase {
  readonly then: VerdictStatus;
  /**
   * The sentence the receipt prints for the clause that decided the call.
   *
   * Optional, and worth writing for any clause that can produce a `FAIL`: it is
   * what a provider reads when they are told they lost a payment, and
   * "FAILURES_AT_LEAST(2)" is not an explanation.
   */
  readonly label?: string;
}

export type DecisionClause =
  | (DecisionClauseBase & {
      readonly when: DecisionTrigger.FAILURES_AT_LEAST;
      readonly count: number;
    })
  | (DecisionClauseBase & {
      readonly when: DecisionTrigger.FAILED_FRACTION_AT_LEAST;
      readonly fraction: number;
    })
  | (DecisionClauseBase & {
      readonly when: DecisionTrigger.VERIFIER_FAILED;
      readonly verifierId: string;
    })
  | (DecisionClauseBase & {
      readonly when: DecisionTrigger.MISAPPLIED_AT_LEAST;
      readonly count: number;
    })
  | (DecisionClauseBase & { readonly when: DecisionTrigger.VOTES_BELOW; readonly count: number });

/** A verifier this policy expects to hear from. */
export interface DecisionVerifierRef {
  readonly verifierId: string;
  /**
   * Human name for the console and the receipt. Defaults to the id.
   */
  readonly label?: string;
}

export interface DecisionPolicy {
  /** Logical id, stable across versions. */
  readonly id: string;
  /** Monotonic per {@link id}. Recorded on every verdict this policy decides. */
  readonly version: number;
  readonly toolId: string;
  readonly verifiers: readonly DecisionVerifierRef[];
  /** Evaluated in order; the first that matches decides. */
  readonly clauses: readonly DecisionClause[];
  /**
   * The verdict when no clause matched.
   *
   * May not be `FAIL`, and {@link validateDecisionPolicy} refuses a policy that
   * says otherwise. A default of `FAIL` is a policy that strikes on silence —
   * on an empty verifier set, on a tool nobody wrote clauses for, on the day a
   * verifier deployment fails. Every one of those is our problem and none of
   * them is evidence about a provider.
   */
  readonly otherwise: VerdictStatus;
}
