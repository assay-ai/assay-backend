import { JsonValue } from '@modules/tool/domain/mapping/mapping.types';
import {
  ParsedPath,
  PathSyntaxError,
  parsePath,
  readCollection,
  readPath,
} from '@modules/tool/domain/mapping/json-path';
import { StageInput } from '../stage';
import { conditionHolds } from './condition';
import {
  FreshnessRule,
  MinArrayLengthRule,
  NoDuplicatesRule,
  RequiredFieldsRule,
  RuleOutcome,
  RuleResult,
  ValidUrlRule,
  ValueRangeRule,
  VerificationRule,
  VerificationRuleType,
} from './rule.types';

/**
 * The six rule evaluators.
 *
 * Every evaluator answers the same four-way question — did it pass, fail,
 * not apply, or was it pointed at something it cannot judge — and the
 * four-way split is not incidental: it is the mechanism `verdict.ts` relies on
 * to keep a policy bug from
 * ever landing on a provider's stake as a `FAIL`. See `rule.types.ts` for the
 * full argument; this file is where it is enforced per rule type.
 *
 * ## The shared preamble
 *
 * Every rule, regardless of type, goes through the same three checks before
 * its type-specific logic ever runs — `resolveTargets` below is that
 * preamble, and it is deliberately factored out rather than repeated six
 * times, because the whole point is that these three checks behave
 * identically for every rule:
 *
 * 1. **Gating.** `appliesWhen` present and not holding ⇒ `NOT_APPLICABLE`,
 *    `gated_off`. Handled in `evaluateRule`, before dispatch — a gated-off
 *    rule never even reaches its type's evaluator.
 * 2. **Selector validity.** A `path` that fails to parse ⇒ `MISAPPLIED`,
 *    `invalid_selector`. A malformed selector is a policy bug, and a policy
 *    bug is never the provider's strike.
 * 3. **Resolution.** `MIN_ARRAY_LENGTH` always reads a collection — measuring
 *    a collection's size is its entire job, wildcard or not. Every other rule
 *    type reads a collection only when its selector has a wildcard (fanning
 *    out over many elements) and a single value otherwise. A selector that
 *    does not resolve at all (`MISSING`) is `MISAPPLIED`, `path_not_found`:
 *    the schema stage already passed, so the response honoured the tool
 *    contract and it is the *rule* pointed at a field the contract never
 *    promised. A wildcard resolving to a present-but-empty collection is
 *    `NOT_APPLICABLE`, `no_items`, for every type except `MIN_ARRAY_LENGTH` —
 *    a vacuous rule has no opinion, which is the same argument `rule.types.ts`
 *    makes for excluding `NOT_APPLICABLE` from the score's denominator.
 *
 * Every evaluator below receives the already-resolved `Target` and only ever
 * has to write the logic that is actually specific to its rule.
 */

// ---------------------------------------------------------------------------
// Resolution — the shared preamble
// ---------------------------------------------------------------------------

/** One resolved element and where it lives, for the pointer on a violation. */
interface ResolvedItem {
  readonly value: JsonValue | null;
  readonly pointer: string;
}

/**
 * Either the elements a rule has to judge, or the `RuleResult` that already
 * settles the rule (a `MISAPPLIED` or `NOT_APPLICABLE` produced while
 * resolving `path`, before any type-specific logic runs).
 */
type Target =
  | { readonly kind: 'ITEMS'; readonly items: readonly ResolvedItem[] }
  | { readonly kind: 'SETTLED'; readonly result: RuleResult };

function resolveTargets(rule: VerificationRule, response: JsonValue): Target {
  let parsed: ParsedPath;
  try {
    parsed = parsePath(rule.path);
  } catch (error) {
    if (error instanceof PathSyntaxError) {
      return {
        kind: 'SETTLED',
        result: misapplied(
          rule,
          'invalid_selector',
          `Selector "${rule.path}" is not valid: ${error.message}`,
        ),
      };
    }
    throw error;
  }

  // MIN_ARRAY_LENGTH's whole job is a collection's size, so it always reads
  // one — with or without a wildcard, `$.results` and `$.pages[*].results`
  // are both "a collection to measure". Every other type only fans out when
  // the selector actually asks it to.
  const readsCollection = parsed.hasWildcard || rule.type === VerificationRuleType.MIN_ARRAY_LENGTH;

  if (!readsCollection) {
    const read = readPath(response, rule.path);
    if (read.kind === 'MISSING') {
      return {
        kind: 'SETTLED',
        result: misapplied(
          rule,
          'path_not_found',
          `Selector "${rule.path}" did not resolve against the response`,
        ),
      };
    }
    const value = read.kind === 'NULL' ? null : read.value;
    return { kind: 'ITEMS', items: [{ value, pointer: pointerFor(parsed) }] };
  }

  const collection = readCollection(response, rule.path);

  if (collection.kind === 'MISSING') {
    return {
      kind: 'SETTLED',
      result: misapplied(
        rule,
        'path_not_found',
        `Selector "${rule.path}" did not resolve against the response`,
      ),
    };
  }

  if (collection.kind === 'NOT_ARRAY') {
    return {
      kind: 'SETTLED',
      result: misapplied(
        rule,
        'not_a_collection',
        `Selector "${rule.path}" resolved to a value that is not a collection`,
      ),
    };
  }

  const items = collection.kind === 'NULL' ? [] : collection.items;

  if (items.length === 0) {
    if (rule.type === VerificationRuleType.MIN_ARRAY_LENGTH) {
      return { kind: 'SETTLED', result: emptyCollection(rule) };
    }
    return {
      kind: 'SETTLED',
      result: notApplicable(
        rule,
        'no_items',
        `Selector "${rule.path}" resolved to an empty collection`,
      ),
    };
  }

  return {
    kind: 'ITEMS',
    items: items.map((value, index) => ({ value, pointer: pointerFor(parsed, index) })),
  };
}

/** Renders a parsed selector as a JSON-pointer-ish location, e.g. `/results/2/url`. */
function pointerFor(parsed: ParsedPath, wildcardIndex?: number): string {
  const parts = parsed.segments.map((segment) => {
    if (segment.kind === 'KEY') return segment.key;
    if (segment.kind === 'INDEX') return String(segment.index);
    return wildcardIndex !== undefined ? String(wildcardIndex) : '*';
  });
  return `/${parts.join('/')}`;
}

// ---------------------------------------------------------------------------
// RuleResult builders
// ---------------------------------------------------------------------------

function passed(rule: VerificationRule): RuleResult {
  return {
    ruleId: rule.id,
    type: rule.type,
    outcome: RuleOutcome.PASSED,
    weight: rule.weight,
    code: null,
    detail: null,
    pointer: null,
  };
}

function failed(
  rule: VerificationRule,
  code: string,
  detail: string,
  pointer: string | null = null,
): RuleResult {
  return {
    ruleId: rule.id,
    type: rule.type,
    outcome: RuleOutcome.FAILED,
    weight: rule.weight,
    code,
    detail,
    pointer,
  };
}

function notApplicable(rule: VerificationRule, code: string, detail: string): RuleResult {
  return {
    ruleId: rule.id,
    type: rule.type,
    outcome: RuleOutcome.NOT_APPLICABLE,
    weight: rule.weight,
    code,
    detail,
    pointer: null,
  };
}

function misapplied(
  rule: VerificationRule,
  code: string,
  detail: string,
  pointer: string | null = null,
): RuleResult {
  return {
    ruleId: rule.id,
    type: rule.type,
    outcome: RuleOutcome.MISAPPLIED,
    weight: rule.weight,
    code,
    detail,
    pointer,
  };
}

/** Only ever produced for `MIN_ARRAY_LENGTH` — see {@link RuleOutcome.EMPTY_COLLECTION}. */
function emptyCollection(rule: MinArrayLengthRule): RuleResult {
  return {
    ruleId: rule.id,
    type: rule.type,
    outcome: RuleOutcome.EMPTY_COLLECTION,
    weight: rule.weight,
    code: 'empty_result',
    detail: `Collection at "${rule.path}" resolved to zero elements`,
    pointer: null,
  };
}

// ---------------------------------------------------------------------------
// Per-type evaluators
// ---------------------------------------------------------------------------

function evaluateMinArrayLength(rule: MinArrayLengthRule, target: Target): RuleResult {
  if (target.kind === 'SETTLED') return target.result;

  const length = target.items.length;
  if (length < rule.min) {
    return failed(
      rule,
      'insufficient_results',
      `${length} results returned, the minimum is ${rule.min}`,
    );
  }
  return passed(rule);
}

function evaluateRequiredFields(rule: RequiredFieldsRule, target: Target): RuleResult {
  if (target.kind === 'SETTLED') return target.result;

  for (const item of target.items) {
    if (typeof item.value !== 'object' || item.value === null || Array.isArray(item.value)) {
      return misapplied(
        rule,
        'not_an_object',
        `Element at ${item.pointer} is not an object`,
        item.pointer,
      );
    }

    const element = item.value as { readonly [key: string]: JsonValue };
    for (const field of rule.fields) {
      if (!Object.prototype.hasOwnProperty.call(element, field)) {
        return failed(
          rule,
          'missing_field',
          `Field "${field}" is missing at ${item.pointer}`,
          `${item.pointer}/${field}`,
        );
      }
      if (element[field] === null && !rule.allowNull) {
        return failed(
          rule,
          'null_field',
          `Field "${field}" is null at ${item.pointer}`,
          `${item.pointer}/${field}`,
        );
      }
    }
  }

  return passed(rule);
}

/**
 * ISO-ish date-time carrying no zone designator — the one form ECMA-262 reads
 * as LOCAL time, and the form open-meteo and many other upstreams return.
 *
 * Deliberately narrow. A date-*only* string (`"2026-08-24"`) is already UTC
 * per the same specification and must not be rewritten; anything carrying `Z`
 * or `±hh:mm` has already said what it means. Both separators are covered
 * because `"2026-08-24 00:00"` is read as local exactly like the `T` form.
 */
const NAIVE_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * An offset-less timestamp is assumed UTC.
 *
 * It is a guess, and it is the one the rest of this platform already makes:
 * every `created_at` is a `timestamptz` in UTC. The alternative —
 * `MISAPPLIED`, "we cannot know the offset" — voids honest calls AND leaves
 * `TESTER_PASSED` unreachable, so it blocks provider onboarding rather than
 * merely being cautious.
 *
 * A NUMBER is still read as epoch MILLISECONDS. An upstream sending epoch
 * seconds is therefore judged as 1970 and fails; that is the same family of
 * false positive and is deliberately NOT fixed here, because the repair needs
 * a magnitude heuristic. No policy in the seeded catalogue maps a numeric
 * timestamp.
 */
function parseTimestamp(value: JsonValue): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(NAIVE_DATE_TIME.test(value) ? `${value}Z` : value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function evaluateFreshness(rule: FreshnessRule, target: Target, evaluatedAt: Date): RuleResult {
  if (target.kind === 'SETTLED') return target.result;

  const allowMissing = rule.allowMissing ?? true;
  const futureToleranceMs = rule.futureToleranceMs ?? 0;
  const nowMs = evaluatedAt.getTime();

  let judgedAny = false;

  for (const item of target.items) {
    if (item.value === null) {
      if (!allowMissing) {
        return failed(
          rule,
          'missing_timestamp',
          `Timestamp is missing at ${item.pointer}`,
          item.pointer,
        );
      }
      // allowMissing: this element is not judged, but a sibling element under
      // a wildcard might still carry a real timestamp — keep going rather
      // than deciding the whole rule off one absent field.
      continue;
    }

    const timestampMs = parseTimestamp(item.value);
    if (timestampMs === null) {
      return misapplied(
        rule,
        'not_a_timestamp',
        `Value at ${item.pointer} is not a parseable timestamp`,
        item.pointer,
      );
    }

    const ageMs = nowMs - timestampMs;
    if (ageMs > rule.maxAgeMs) {
      return failed(
        rule,
        'stale_timestamp',
        `Timestamp at ${item.pointer} is ${ageMs}ms old, the maximum is ${rule.maxAgeMs}ms`,
        item.pointer,
      );
    }
    if (-ageMs > futureToleranceMs) {
      return failed(
        rule,
        'future_timestamp',
        `Timestamp at ${item.pointer} is ${-ageMs}ms in the future, the tolerance is ${futureToleranceMs}ms`,
        item.pointer,
      );
    }

    judgedAny = true;
  }

  if (!judgedAny) {
    // Reachable only when every candidate element was missing/null and
    // `allowMissing` let each one pass — there was nothing left to judge.
    // Same code as the single-value FAILED case, different outcome: the fact
    // ("no timestamp") is identical, only whether it was permitted differs.
    return notApplicable(rule, 'missing_timestamp', 'No timestamp was present to judge');
  }
  return passed(rule);
}

function evaluateValueRange(rule: ValueRangeRule, target: Target): RuleResult {
  if (rule.min === undefined && rule.max === undefined) {
    // A rule with no band can never fail, regardless of what the data holds —
    // that is not a lenient policy, it is a policy that says nothing while
    // looking like it says something. Checked before resolution: this is
    // wrong about the *rule*, not about the response, so it does not matter
    // what the selector would have found.
    return misapplied(rule, 'no_bounds_declared', 'Rule declares neither a minimum nor a maximum');
  }

  if (target.kind === 'SETTLED') return target.result;

  const allowMissing = rule.allowMissing ?? true;
  let judgedAny = false;

  for (const item of target.items) {
    if (item.value === null) {
      if (!allowMissing) {
        return failed(rule, 'missing_value', `Value is missing at ${item.pointer}`, item.pointer);
      }
      continue;
    }

    if (typeof item.value !== 'number' || !Number.isFinite(item.value)) {
      return misapplied(
        rule,
        'not_a_number',
        `Value at ${item.pointer} is not a finite number`,
        item.pointer,
      );
    }

    const belowMin = rule.min !== undefined && item.value < rule.min;
    const aboveMax = rule.max !== undefined && item.value > rule.max;
    if (belowMin || aboveMax) {
      const band = `[${rule.min ?? '-∞'}, ${rule.max ?? '∞'}]`;
      return failed(
        rule,
        'out_of_range',
        `Value ${item.value} at ${item.pointer} is outside ${band}`,
        item.pointer,
      );
    }

    judgedAny = true;
  }

  if (!judgedAny) {
    return notApplicable(rule, 'missing_value', 'No value was present to judge');
  }
  return passed(rule);
}

function evaluateValidUrl(rule: ValidUrlRule, target: Target): RuleResult {
  if (target.kind === 'SETTLED') return target.result;

  const schemes = (rule.schemes ?? ['http', 'https']).map((scheme) => scheme.toLowerCase());

  for (const item of target.items) {
    if (typeof item.value !== 'string') {
      return misapplied(
        rule,
        'not_a_string',
        `Value at ${item.pointer} is not a string`,
        item.pointer,
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(item.value);
    } catch {
      return failed(
        rule,
        'invalid_url',
        `"${item.value}" at ${item.pointer} does not parse as a URL`,
        item.pointer,
      );
    }

    // `URL.protocol` keeps its trailing colon ("https:"), which is not a
    // scheme name — strip it before comparing against the allow-list.
    const scheme = parsed.protocol.slice(0, -1).toLowerCase();
    if (!schemes.includes(scheme)) {
      return failed(
        rule,
        'disallowed_scheme',
        `Scheme "${scheme}" at ${item.pointer} is not in [${schemes.join(', ')}]`,
        item.pointer,
      );
    }
  }

  return passed(rule);
}

type ScalarKey = string;

/** Comparison key that keeps types apart (`1` the number and `"1"` the string are not duplicates). */
function comparisonKey(value: JsonValue | null, caseInsensitive: boolean): ScalarKey {
  if (value === null) return 'null';
  if (typeof value === 'string') return `s:${caseInsensitive ? value.toLowerCase() : value}`;
  if (typeof value === 'number') return `n:${value}`;
  if (typeof value === 'boolean') return `b:${value}`;
  return 'unreachable';
}

function evaluateNoDuplicates(rule: NoDuplicatesRule, target: Target): RuleResult {
  if (target.kind === 'SETTLED') return target.result;

  if (target.items.length < 2) {
    // Nothing to compare against. Not the empty-collection case (that never
    // reaches here — it settles in `resolveTargets`) — this is a collection
    // with exactly zero or one element, where duplication is not a
    // meaningful question.
    return notApplicable(rule, 'too_few_values', 'Fewer than two values were present to compare');
  }

  const caseInsensitive = rule.caseInsensitive ?? false;
  const seen = new Map<ScalarKey, { readonly value: JsonValue | null; readonly pointer: string }>();

  for (const item of target.items) {
    const isScalar =
      item.value === null ||
      typeof item.value === 'string' ||
      typeof item.value === 'number' ||
      typeof item.value === 'boolean';
    if (!isScalar) {
      return misapplied(
        rule,
        'not_comparable',
        `Value at ${item.pointer} is not a scalar`,
        item.pointer,
      );
    }

    const key = comparisonKey(item.value, caseInsensitive);
    const prior = seen.get(key);
    if (prior) {
      return failed(
        rule,
        'duplicate_values',
        `Value "${String(item.value)}" at ${item.pointer} duplicates the one at ${prior.pointer}`,
        item.pointer,
      );
    }
    seen.set(key, { value: item.value, pointer: item.pointer });
  }

  return passed(rule);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export function evaluateRule(rule: VerificationRule, input: StageInput): RuleResult {
  if (rule.appliesWhen && !conditionHolds(rule.appliesWhen, input)) {
    return notApplicable(
      rule,
      'gated_off',
      `Gate condition on "${rule.appliesWhen.path}" did not hold`,
    );
  }

  const target = resolveTargets(rule, input.response);

  switch (rule.type) {
    case VerificationRuleType.MIN_ARRAY_LENGTH:
      return evaluateMinArrayLength(rule, target);
    case VerificationRuleType.REQUIRED_FIELDS:
      return evaluateRequiredFields(rule, target);
    case VerificationRuleType.FRESHNESS:
      return evaluateFreshness(rule, target, input.evaluatedAt);
    case VerificationRuleType.VALUE_RANGE:
      return evaluateValueRange(rule, target);
    case VerificationRuleType.VALID_URL:
      return evaluateValidUrl(rule, target);
    case VerificationRuleType.NO_DUPLICATES:
      return evaluateNoDuplicates(rule, target);
    default:
      // Exhaustive over `VerificationRuleType`; unreachable for a well-typed
      // policy. A policy loaded from storage that names an unknown type is
      // the one case a rule genuinely cannot judge itself, so it MISAPPLIEs
      // rather than throwing out of a pure evaluator.
      return misapplied(
        rule,
        'unknown_rule_type',
        `Unrecognised rule type: ${(rule as VerificationRule).type}`,
      );
  }
}

export function evaluateRules(
  rules: readonly VerificationRule[],
  input: StageInput,
): readonly RuleResult[] {
  return rules.map((rule) => evaluateRule(rule, input));
}
