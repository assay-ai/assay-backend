/**
 * The deterministic rule dialect (stage 2).
 *
 * Six rule types, all data, all pure, all ~1ms over the whole response. They
 * are the layer that catches the most failures for the least money, which is
 * why they run on **every** call rather than a sample — and why the dialect is
 * kept small enough that a provider can read a policy and predict its verdict.
 * A rule that needs an expression is a rule the provider cannot audit, and a
 * verdict a provider cannot audit is a slash they cannot defend against.
 *
 * ## The two outcomes that are not pass and not fail
 *
 * Both exist to stop a false `FAIL`, and both were bought at the cost of one
 * enum member each:
 *
 * - **`NOT_APPLICABLE`** — the rule was never in play. Either the policy gated
 *   it on a condition that does not hold, or its selector fanned out over an
 *   empty collection so there was nothing to check. A vacuous rule must not
 *   drag the score down; it is excluded from the denominator entirely.
 * - **`MISAPPLIED`** — the rule was in play and could not judge what it found.
 *   A freshness rule pointed at a boolean, a range rule pointed at a string, a
 *   selector that resolves to nothing at all. The response is not the thing
 *   that is wrong here; the policy is. It voids the call rather than failing
 *   the provider.
 */

import { JsonValue } from '@modules/tool/domain/mapping/mapping.types';

export enum VerificationRuleType {
  /** The collection at `path` has at least `min` elements. */
  MIN_ARRAY_LENGTH = 'MIN_ARRAY_LENGTH',
  /** Every element at `path` carries every one of `fields`, non-null. */
  REQUIRED_FIELDS = 'REQUIRED_FIELDS',
  /** Every timestamp at `path` is no older than `maxAgeMs`. */
  FRESHNESS = 'FRESHNESS',
  /** Every number at `path` lies inside the declared band. */
  VALUE_RANGE = 'VALUE_RANGE',
  /** Every string at `path` parses as a URL with an allowed scheme. */
  VALID_URL = 'VALID_URL',
  /** The values at `path` are distinct. */
  NO_DUPLICATES = 'NO_DUPLICATES',
}

/**
 * A gate on a rule: it applies only when this holds.
 *
 * The declarative half of misapplication prevention. A policy that says *"the
 * freshness rule applies only when the caller asked for recent data"* turns
 * what would have been a wrong `FAIL` into a `NOT_APPLICABLE` — stated by the
 * policy author, at authoring time, instead of discovered by a provider in a
 * dispute.
 *
 * Deliberately not an expression language. Four operators over one selector is
 * enough for every gate the catalogue has needed, and each one can be shown to
 * a provider as a sentence.
 */
export interface RuleCondition {
  /** Selector, in the mapping engine's dialect. */
  readonly path: string;
  /** Which document to read. Defaults to the response. */
  readonly source?: ConditionSource;
  readonly operator: ConditionOperator;
  /** Compared value for `EQUALS`; the allowed set for `IN`. Unused otherwise. */
  readonly value?: JsonValue | readonly JsonValue[];
}

export enum ConditionSource {
  RESPONSE = 'RESPONSE',
  /** The tool arguments the agent sent. */
  REQUEST = 'REQUEST',
}

export enum ConditionOperator {
  /** The selector resolves to a value that is not `null`. */
  EXISTS = 'EXISTS',
  /** The selector does not resolve, or resolves to `null`. */
  ABSENT = 'ABSENT',
  EQUALS = 'EQUALS',
  IN = 'IN',
}

interface BaseRule {
  /**
   * Stable within a policy version. It is what the receipt names, what metrics
   * group by, and what a provider quotes in a dispute — so it survives edits to
   * the rule's parameters and dies with the rule.
   */
  readonly id: string;
  readonly type: VerificationRuleType;
  /** Selector, in the mapping engine's dialect. `$.results[*].url` and friends. */
  readonly path: string;
  /**
   * Share of the stage's score, `0..1`.
   *
   * Weights are renormalised over the rules that actually applied, so a policy
   * whose weights sum to 1 keeps its threshold meaning when half its rules turn
   * out to be inapplicable.
   */
  readonly weight: number;
  readonly appliesWhen?: RuleCondition;
}

export interface MinArrayLengthRule extends BaseRule {
  readonly type: VerificationRuleType.MIN_ARRAY_LENGTH;
  /**
   * `1`, essentially always.
   *
   * This is deliberately 1 and not 10: a query with one good answer is not a
   * provider failure, and thresholds that assume a rich result set are the most
   * common source of false positives. An empty collection does not fail this
   * rule at all — it routes to the empty-result policy. See
   * {@link RuleOutcome.EMPTY_COLLECTION}.
   */
  readonly min: number;
}

export interface RequiredFieldsRule extends BaseRule {
  readonly type: VerificationRuleType.REQUIRED_FIELDS;
  readonly fields: readonly string[];
  /**
   * Treat an explicit `null` as present.
   *
   * Off by default: a provider returning `{"url": null}` has not given the
   * agent a usable URL. On for fields where "we have no value" is a legitimate
   * answer the agent can act on.
   */
  readonly allowNull?: boolean;
}

export interface FreshnessRule extends BaseRule {
  readonly type: VerificationRuleType.FRESHNESS;
  /**
   * Maximum age in milliseconds, measured from `StageInput.evaluatedAt`.
   *
   * Milliseconds rather than a `"30d"` duration string: a duration string
   * is a second dialect to parse, validate and mis-read, and this one would be
   * authored in the binding editor, where a number field with a unit label is
   * both clearer and unambiguous.
   */
  readonly maxAgeMs: number;
  /**
   * Tolerance for a timestamp in the future, in milliseconds. Default 0.
   *
   * Clock skew between a provider's host and ours is real and is not a quality
   * defect. Without a tolerance, a provider whose clock runs four seconds fast
   * fails a freshness rule on every call.
   */
  readonly futureToleranceMs?: number;
  /** Absent or `null` timestamps are not judged. Default `true`. */
  readonly allowMissing?: boolean;
}

export interface ValueRangeRule extends BaseRule {
  readonly type: VerificationRuleType.VALUE_RANGE;
  /** Inclusive lower bound. */
  readonly min?: number;
  /** Inclusive upper bound. */
  readonly max?: number;
  /** Absent or `null` values are not judged. Default `true`. */
  readonly allowMissing?: boolean;
}

export interface ValidUrlRule extends BaseRule {
  readonly type: VerificationRuleType.VALID_URL;
  /** Default `['http', 'https']`. */
  readonly schemes?: readonly string[];
}

export interface NoDuplicatesRule extends BaseRule {
  readonly type: VerificationRuleType.NO_DUPLICATES;
  /** Compare strings case-insensitively. Default `false`. */
  readonly caseInsensitive?: boolean;
}

export type VerificationRule =
  | MinArrayLengthRule
  | RequiredFieldsRule
  | FreshnessRule
  | ValueRangeRule
  | ValidUrlRule
  | NoDuplicatesRule;

export enum RuleOutcome {
  PASSED = 'PASSED',
  FAILED = 'FAILED',
  /**
   * The rule never applied: gated off by `appliesWhen`, or its selector fanned
   * out over zero elements so there was nothing to judge.
   *
   * Excluded from the score's denominator. A rule that did not run has no
   * opinion, and averaging it in as a zero is how an inapplicable rule fails an
   * honest response.
   */
  NOT_APPLICABLE = 'NOT_APPLICABLE',
  /**
   * The rule's collection resolved and is empty.
   *
   * Only `MIN_ARRAY_LENGTH` produces this, and it is not a failure: it is the
   * signal that hands the response to the empty-result policy, which is where
   * `EMPTY_CONFIRMED` and `EMPTY_UNVERIFIED` are decided.
   */
  EMPTY_COLLECTION = 'EMPTY_COLLECTION',
  /**
   * The rule could not judge what its selector found — wrong type, wrong shape,
   * or a selector that resolves to nothing.
   *
   * The policy is at fault, so the call is voided and the provider is untouched.
   */
  MISAPPLIED = 'MISAPPLIED',
}

export interface RuleResult {
  readonly ruleId: string;
  readonly type: VerificationRuleType;
  readonly outcome: RuleOutcome;
  readonly weight: number;
  /** Stable machine-readable reason, e.g. `stale_timestamp`. `null` on a pass. */
  readonly code: string | null;
  /** One human sentence with the specifics. */
  readonly detail: string | null;
  /** Where the violation was found, as a JSON pointer. */
  readonly pointer: string | null;
}
