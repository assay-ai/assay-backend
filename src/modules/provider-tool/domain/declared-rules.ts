import { isValidPath } from '@modules/tool/domain/mapping/json-path';
import {
  ConditionOperator,
  ConditionSource,
  VerificationRule,
  VerificationRuleType,
} from '@modules/verification/domain/rules/rule.types';

/**
 * The verification rules a provider declares for its own tool (design spec
 * §7.6 "Verification": "rules the provider declares"), in the existing
 * deterministic dialect — the six rule types, nothing else. Pure.
 *
 * They are registered as the tool's verification policy in SHADOW: judged
 * and recorded on every call, with no economic effect until an operator
 * promotes the policy through the existing promotion gate. A provider's own
 * words never strike anybody, itself included, without that gate.
 */

export const DECLARED_RULES_MAX = 20;
const RULE_ID_RE = /^[a-z][a-z0-9_]{1,63}$/;
const PATH_MAX = 256;
const URL_SCHEMES = new Set(['http', 'https']);

/** Why `rules` cannot be declared; empty when they can. */
export function declaredRuleProblems(rules: unknown): string[] {
  if (rules === undefined || rules === null) return [];
  if (!Array.isArray(rules)) return ['rules must be a list'];
  const problems: string[] = [];
  if (rules.length > DECLARED_RULES_MAX) problems.push(`at most ${DECLARED_RULES_MAX} rules`);
  const ids = new Set<string>();
  rules.forEach((raw, index) => {
    const at = `rule ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${at} is not an object`);
      return;
    }
    const rule = raw as Record<string, unknown>;
    if (typeof rule.id !== 'string' || !RULE_ID_RE.test(rule.id)) {
      problems.push(`${at}: id must match ${RULE_ID_RE.source}`);
    } else if (ids.has(rule.id)) {
      problems.push(`${at}: id "${rule.id}" is used twice`);
    } else {
      ids.add(rule.id);
    }
    if (!Object.values(VerificationRuleType).includes(rule.type as VerificationRuleType)) {
      problems.push(`${at}: type must be one of ${Object.values(VerificationRuleType).join(', ')}`);
      return;
    }
    if (!isPath(rule.path)) problems.push(`${at}: path is not a selector`);
    if (typeof rule.weight !== 'number' || !(rule.weight > 0) || rule.weight > 1) {
      problems.push(`${at}: weight must be in (0, 1]`);
    }
    if (rule.appliesWhen !== undefined) problems.push(...conditionProblems(at, rule.appliesWhen));

    switch (rule.type as VerificationRuleType) {
      case VerificationRuleType.MIN_ARRAY_LENGTH:
        if (
          !Number.isInteger(rule.min) ||
          (rule.min as number) < 1 ||
          (rule.min as number) > 1000
        ) {
          problems.push(`${at}: min must be an integer from 1 to 1000`);
        }
        break;
      case VerificationRuleType.REQUIRED_FIELDS:
        if (
          !Array.isArray(rule.fields) ||
          rule.fields.length === 0 ||
          rule.fields.length > 50 ||
          !rule.fields.every(
            (field) => typeof field === 'string' && field.length > 0 && field.length <= 64,
          )
        ) {
          problems.push(`${at}: fields must be 1–50 field names`);
        }
        break;
      case VerificationRuleType.FRESHNESS:
        if (!Number.isInteger(rule.maxAgeMs) || (rule.maxAgeMs as number) <= 0) {
          problems.push(`${at}: maxAgeMs must be a positive integer`);
        }
        if (
          rule.futureToleranceMs !== undefined &&
          (!Number.isInteger(rule.futureToleranceMs) || (rule.futureToleranceMs as number) < 0)
        ) {
          problems.push(`${at}: futureToleranceMs must be a non-negative integer`);
        }
        break;
      case VerificationRuleType.VALUE_RANGE: {
        const min = rule.min;
        const max = rule.max;
        if (min === undefined && max === undefined) problems.push(`${at}: set min, max or both`);
        if (min !== undefined && !Number.isFinite(min))
          problems.push(`${at}: min must be a number`);
        if (max !== undefined && !Number.isFinite(max))
          problems.push(`${at}: max must be a number`);
        if (Number.isFinite(min) && Number.isFinite(max) && (min as number) > (max as number)) {
          problems.push(`${at}: min is above max`);
        }
        break;
      }
      case VerificationRuleType.VALID_URL:
        if (
          rule.schemes !== undefined &&
          (!Array.isArray(rule.schemes) ||
            !rule.schemes.every((scheme) => typeof scheme === 'string' && URL_SCHEMES.has(scheme)))
        ) {
          problems.push(`${at}: schemes may be http and https only`);
        }
        break;
      case VerificationRuleType.NO_DUPLICATES:
        break;
    }
  });
  return problems;
}

/** The declared rules, typed, after {@link declaredRuleProblems} found none. */
export function asDeclaredRules(rules: unknown): VerificationRule[] {
  return (Array.isArray(rules) ? rules : []) as VerificationRule[];
}

function conditionProblems(at: string, raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [`${at}: appliesWhen must be an object`];
  }
  const condition = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (!isPath(condition.path)) problems.push(`${at}: appliesWhen.path is not a selector`);
  if (!Object.values(ConditionOperator).includes(condition.operator as ConditionOperator)) {
    problems.push(
      `${at}: appliesWhen.operator is not one of ${Object.values(ConditionOperator).join(', ')}`,
    );
  }
  if (
    condition.source !== undefined &&
    !Object.values(ConditionSource).includes(condition.source as ConditionSource)
  ) {
    problems.push(`${at}: appliesWhen.source is RESPONSE or REQUEST`);
  }
  return problems;
}

function isPath(value: unknown): boolean {
  return typeof value === 'string' && value.length <= PATH_MAX && isValidPath(value);
}
