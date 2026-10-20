import { Injectable, Logger } from '@nestjs/common';

import { PolicyLifecycle } from '@modules/verification/domain/aggregation/decision-policy.types';
import { PolicyMode, VerificationPolicy } from '@modules/verification/domain/policy.types';
import { VerdictStatus } from '@modules/verification/domain/verdict';
import { DecisionPolicyService } from '@modules/verification/services/decision-policy.service';
import {
  DecisionClause,
  DecisionTrigger,
} from '@modules/verification/domain/aggregation/decision-policy.types';

import { asDeclaredRules } from '../domain/declared-rules';

/**
 * The policy id a provider tool is judged by: one per tool, versioned by the
 * policy service. Keyed on the tool's id, never its name, which follows a
 * handle rename.
 */
export function providerPolicyId(toolId: string): string {
  return `provider-tool:${toolId}`;
}

/** A rule set scores its passed weight over the weight that applied; below this it fails. */
export const PROVIDER_POLICY_PASS_THRESHOLD = 0.7;

/**
 * A provider tool's verification (design spec §7.6 "Verification"): the
 * schema on every call, the SLA, and the rules the provider declares.
 *
 * Each published version registers the tool's policy — the response shape
 * and the declared rules — as a new version of `{name}.provider`, **in
 * SHADOW**: judged and recorded on every call, with no economic effect. A
 * provider's own rules start enforcing only when an operator promotes the
 * policy through the existing promotion gate, on measured shadow evidence;
 * nothing here can make one ACTIVE. The synchronous schema check of the call
 * path refunds a call that breaks the output schema whatever the policy says.
 *
 * No cross-provider check: a provider tool has one implementation.
 */
@Injectable()
export class ProviderToolPolicyService {
  private readonly logger = new Logger(ProviderToolPolicyService.name);

  constructor(private readonly policies: DecisionPolicyService) {}

  async registerShadow(input: {
    readonly toolId: string;
    readonly toolName: string;
    readonly organizationId: string;
    readonly rules: unknown;
  }): Promise<void> {
    const id = providerPolicyId(input.toolId);
    const rules = asDeclaredRules(input.rules);
    const verificationPolicy: VerificationPolicy = {
      id,
      toolId: input.toolId,
      version: 1,
      rules,
      passThreshold: PROVIDER_POLICY_PASS_THRESHOLD,
      mode: PolicyMode.SHADOW,
      crossCheck: { enabled: false },
      semantic: { enabled: false },
    } as VerificationPolicy;
    try {
      await this.policies.register({
        draft: {
          id,
          toolId: input.toolId,
          verifiers: [
            { verifierId: 'schema', label: 'Response shape' },
            ...(rules.length > 0 ? [{ verifierId: 'rules', label: 'Declared rules' }] : []),
          ],
          clauses: clausesOf(rules.length > 0),
          otherwise: VerdictStatus.PASS,
        },
        verificationPolicy,
        createdBy: `provider:${input.organizationId}`,
        startIn: PolicyLifecycle.SHADOW,
      });
    } catch (error) {
      // The version is published either way; the call path's own schema
      // check still refunds a broken answer. Logged for whoever owns it.
      this.logger.warn(
        `${input.toolName}: shadow policy not registered — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** The decision clauses: a misapplied check voids, the schema or a declared rule fails. */
function clausesOf(withRules: boolean): DecisionClause[] {
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
      label: 'The response broke a rule its provider declared.',
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
