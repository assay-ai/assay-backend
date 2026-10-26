import { EntityManager } from 'typeorm';

import { VerificationPolicyEntity } from '@database/postgres/entities/verification-policy.entity';
import {
  DecisionPolicy,
  PolicyLifecycle,
  defaultDecisionPolicy,
  defaultVerificationPolicy,
} from '@modules/verification/domain/aggregation';
import { EmptyResultPolicy } from '@modules/verification/domain/policy.types';
import { VerificationRule } from '@modules/verification/domain/rules/rule.types';
import {
  DecisionPolicyService,
  RegisterPolicyInput,
} from '@modules/verification/services/decision-policy.service';

/**
 * The author recorded on a policy the platform registered by itself (on P-10
 * publish). Not an operator id, so it bars nobody from labelling or approving.
 */
export const AUTO_POLICY_AUTHOR = 'system';

/** The policy id a standard tool is judged by, stable across versions. */
export function standardPolicyId(toolName: string): string {
  return `${toolName}.default`;
}

/** A standard tool's policy: the default decision rules over its declared checks, in SHADOW. */
export function standardShadowInput(input: {
  readonly toolId: string;
  readonly toolName: string;
  readonly rules: readonly VerificationRule[];
  readonly passThreshold?: number;
  readonly emptyResult?: EmptyResultPolicy;
  readonly createdBy: string;
}): RegisterPolicyInput {
  const id = standardPolicyId(input.toolName);
  return {
    draft: defaultDecisionPolicy({
      id,
      toolId: input.toolId,
      withRules: input.rules.length > 0,
      rulesLabel: 'The response broke a rule set for this tool.',
    }),
    verificationPolicy: defaultVerificationPolicy({
      id,
      toolId: input.toolId,
      rules: input.rules,
      passThreshold: input.passThreshold,
      emptyResult: input.emptyResult,
    }),
    createdBy: input.createdBy,
    startIn: PolicyLifecycle.SHADOW,
  };
}

/**
 * On publish (P-10): a shape-only trial policy, so evidence is collected from
 * the first call. Idempotent: a tool that has any policy row already — trial,
 * live, withdrawn or archived — is left alone, so a republish never adds a
 * version and never brings back a policy an operator withdrew. Runs in the
 * publish transaction, which holds the tool row's lock.
 */
export async function registerDefaultShadowIfNone(
  policies: DecisionPolicyService,
  manager: EntityManager,
  tool: { readonly id: string; readonly name: string },
): Promise<DecisionPolicy | null> {
  const existing = await manager.count(VerificationPolicyEntity, { where: { toolId: tool.id } });
  if (existing > 0) return null;
  return policies.register(
    standardShadowInput({
      toolId: tool.id,
      toolName: tool.name,
      rules: [],
      createdBy: AUTO_POLICY_AUTHOR,
    }),
    manager,
  );
}
