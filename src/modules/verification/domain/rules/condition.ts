import { JsonValue } from '@modules/tool/domain/mapping/mapping.types';
import { PathRead, PathSyntaxError, readPath } from '@modules/tool/domain/mapping/json-path';
import { StageInput } from '../stage';
import { ConditionOperator, ConditionSource, RuleCondition } from './rule.types';

/**
 * Evaluates a {@link RuleCondition}.
 *
 * Two call sites, and they must never fail differently:
 *
 * - `evaluateRule`'s `appliesWhen` gate — does this rule apply at all?
 * - `decideEmptyResult`'s `evidence` — does the response itself corroborate an
 *   empty answer?
 *
 * Both uses are structurally the same question — "does this fact hold about
 * the input?" — and both are wired so that an unanswerable question resolves
 * to "no" rather than throwing:
 *
 * - As a gate, "no" means `NOT_APPLICABLE` for the rule it guards — the
 *   rule simply does not run, which is always the safe direction.
 * - As evidence, "no" means one fewer corroborating condition, which can only
 *   push the empty-result verdict from `EMPTY_CONFIRMED` toward
 *   `EMPTY_UNVERIFIED` — still a pass, just an unconfirmed one.
 *
 * A condition therefore never has a reason to throw. A malformed `path` in
 * `appliesWhen` is a policy-authoring bug the same way a malformed rule
 * selector is (see `evaluate-rules.ts`), and a policy bug must not become an
 * exception that takes the whole stage down with it — it must resolve toward
 * the outcome that costs an honest provider nothing.
 */
export function conditionHolds(condition: RuleCondition, input: StageInput): boolean {
  const source = condition.source ?? ConditionSource.RESPONSE;
  const document: JsonValue | undefined =
    source === ConditionSource.REQUEST ? input.request : input.response;

  if (document === undefined) {
    // Only reachable for `ConditionSource.REQUEST`: not every call carries a
    // request document, and a condition that reads one that is not there
    // cannot be answered. "Cannot be answered" resolves to "does not hold" —
    // see the file docblock for why that direction is always the safe one.
    return false;
  }

  let read: PathRead;
  try {
    read = readPath(document, condition.path);
  } catch (error) {
    if (error instanceof PathSyntaxError) {
      // A gate that cannot even parse is a policy bug, not a fact about this
      // response. It must not throw out of what the engine treats as a pure
      // predicate, and it must not silently make the gate hold either — both
      // of those would let a typo in `appliesWhen` decide someone's money.
      return false;
    }
    throw error;
  }

  switch (condition.operator) {
    case ConditionOperator.EXISTS:
      return read.kind === 'FOUND';

    case ConditionOperator.ABSENT:
      return read.kind === 'MISSING' || read.kind === 'NULL';

    case ConditionOperator.EQUALS: {
      const resolved = resolvedValue(read);
      return resolved.present && jsonEquals(resolved.value, condition.value as JsonValue);
    }

    case ConditionOperator.IN: {
      const resolved = resolvedValue(read);
      if (!resolved.present || !Array.isArray(condition.value)) return false;
      return condition.value.some((candidate) => jsonEquals(resolved.value, candidate));
    }

    default:
      return false;
  }
}

/**
 * Folds `PathRead`'s `FOUND` / `NULL` distinction into "is there a value to
 * compare, and what is it" — `EQUALS null` and `IN [null, ...]` are legitimate
 * things for a policy author to write, so an explicit `null` counts as present
 * with value `null`. `MISSING` is never present: there is nothing to compare,
 * and `ABSENT` is the operator for that question, not `EQUALS`.
 */
function resolvedValue(read: PathRead): {
  readonly present: boolean;
  readonly value: JsonValue | null;
} {
  if (read.kind === 'FOUND') return { present: true, value: read.value };
  if (read.kind === 'NULL') return { present: true, value: null };
  return { present: false, value: null };
}

/**
 * Structural equality over JSON values.
 *
 * `condition.value` comes off a stored policy, not out of the response, so it
 * is small and shallow in every real case (`$.status EQUALS "no_results"`,
 * `$.totalResults EQUALS 0`) — but a plain `===` would silently mis-answer the
 * moment someone writes an object or array constant, and there is nothing in
 * the type that forbids it.
 */
function jsonEquals(a: JsonValue | null, b: JsonValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, index) => jsonEquals(item, b[index]));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && jsonEquals(a[key], b[key]),
    );
  }

  return false;
}
