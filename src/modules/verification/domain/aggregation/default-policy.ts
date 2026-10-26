/**
 * The one decision policy the platform writes itself, for every tool that has
 * no hand-written one: the response shape, plus the deterministic rules when
 * any are declared. Provider tools (their provider's rules) and standard tools
 * (an operator's rules, or none) both use it, so nobody writes decision
 * clauses by hand. Pure.
 */

import { EmptyResultPolicy, PolicyMode, VerificationPolicy } from '../policy.types';
import { VerificationRule } from '../rules/rule.types';
import { VerdictStatus } from '../verdict';
import { DecisionClause, DecisionPolicy, DecisionTrigger } from './decision-policy.types';

/** A rule set scores its passed weight over the weight that applied; below this it fails. */
export const DEFAULT_PASS_THRESHOLD = 0.7;

export interface DefaultDecisionPolicyInput {
  readonly id: string;
  readonly toolId: string;
  /** Whether a `rules` verifier votes (the policy declares deterministic rules). */
  readonly withRules: boolean;
  /** The receipt line of a failed rule; defaults to the provider-tool wording. */
  readonly rulesLabel?: string;
}

/** The decision document: schema and rules vote; a misapplied check voids. */
export function defaultDecisionPolicy(
  input: DefaultDecisionPolicyInput,
): Omit<DecisionPolicy, 'version'> {
  return {
    id: input.id,
    toolId: input.toolId,
    verifiers: [
      { verifierId: 'schema', label: 'Response shape' },
      ...(input.withRules ? [{ verifierId: 'rules', label: 'Declared rules' }] : []),
    ],
    clauses: defaultClauses(input.withRules, input.rulesLabel),
    otherwise: VerdictStatus.PASS,
  };
}

export interface DefaultVerificationPolicyInput {
  readonly id: string;
  readonly toolId: string;
  readonly rules: readonly VerificationRule[];
  readonly passThreshold?: number;
  readonly emptyResult?: EmptyResultPolicy;
}

/** The local checks the default decision policy votes on, in SHADOW mode. */
export function defaultVerificationPolicy(
  input: DefaultVerificationPolicyInput,
): VerificationPolicy {
  return {
    id: input.id,
    toolId: input.toolId,
    version: 1,
    rules: input.rules,
    passThreshold: input.passThreshold ?? DEFAULT_PASS_THRESHOLD,
    ...(input.emptyResult ? { emptyResult: input.emptyResult } : {}),
    mode: PolicyMode.SHADOW,
    crossCheck: { enabled: false },
    semantic: { enabled: false },
  } as VerificationPolicy;
}

/** The decision clauses: a misapplied check voids, the schema or a declared rule fails. */
function defaultClauses(
  withRules: boolean,
  rulesLabel = 'The response broke a rule its provider declared.',
): DecisionClause[] {
  const clauses: DecisionClause[] = [
    {
      when: DecisionTrigger.MISAPPLIED_AT_LEAST,
      count: 1,
      then: VerdictStatus.MISAPPLIED,
      label: 'A check did not fit this response; the call was not charged.',
    },
    {
      when: DecisionTrigger.VERIFIER_FAILED,
      verifierId: 'schema',
      then: VerdictStatus.FAIL,
      label: 'The response did not match the shape this tool promises.',
    },
  ];
  if (withRules) {
    clauses.push({
      when: DecisionTrigger.VERIFIER_FAILED,
      verifierId: 'rules',
      then: VerdictStatus.FAIL,
      label: rulesLabel,
    });
  }
  clauses.push({
    when: DecisionTrigger.VOTES_BELOW,
    count: 1,
    then: VerdictStatus.DEGRADED,
    label: 'Too few checks completed to judge this response.',
  });
  return clauses;
}
