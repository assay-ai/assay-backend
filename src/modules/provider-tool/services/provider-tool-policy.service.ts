import { Injectable, Logger } from '@nestjs/common';

import {
  DEFAULT_PASS_THRESHOLD,
  defaultDecisionPolicy,
  defaultVerificationPolicy,
} from '@modules/verification/domain/aggregation/default-policy';
import { PolicyLifecycle } from '@modules/verification/domain/aggregation/decision-policy.types';
import { DecisionPolicyService } from '@modules/verification/services/decision-policy.service';

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
export const PROVIDER_POLICY_PASS_THRESHOLD = DEFAULT_PASS_THRESHOLD;

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
    const verificationPolicy = defaultVerificationPolicy({
      id,
      toolId: input.toolId,
      rules,
      passThreshold: PROVIDER_POLICY_PASS_THRESHOLD,
    });
    try {
      await this.policies.register({
        draft: defaultDecisionPolicy({ id, toolId: input.toolId, withRules: rules.length > 0 }),
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
