import { EntityManager } from 'typeorm';

import { ProviderToolPolicyService } from '@modules/provider-tool/services/provider-tool-policy.service';
import {
  AUTO_POLICY_AUTHOR,
  registerDefaultShadowIfNone,
  standardShadowInput,
} from '@modules/operator/services/standard-tool-policy';
import {
  DecisionTrigger,
  PolicyLifecycle,
  defaultDecisionPolicy,
} from '@modules/verification/domain/aggregation';
import { PolicyMode } from '@modules/verification/domain/policy.types';
import { VerificationRuleType } from '@modules/verification/domain/rules/rule.types';
import { VerdictStatus } from '@modules/verification/domain/verdict';
import {
  DecisionPolicyService,
  RegisterPolicyInput,
} from '@modules/verification/services/decision-policy.service';

/**
 * The one decision policy the platform writes itself. Provider tools got it
 * from `clausesOf` in the provider-tool policy service; standard tools now get
 * the same rules, so these pin it to what provider tools were registered with.
 */
const PROVIDER_CLAUSES_WITH_RULES = [
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
  {
    when: DecisionTrigger.VERIFIER_FAILED,
    verifierId: 'rules',
    then: VerdictStatus.FAIL,
    label: 'The response broke a rule its provider declared.',
  },
  {
    when: DecisionTrigger.VOTES_BELOW,
    count: 1,
    then: VerdictStatus.DEGRADED,
    label: 'Too few checks completed to judge this response.',
  },
];

const RULE = {
  id: 'has_results',
  type: VerificationRuleType.MIN_ARRAY_LENGTH,
  path: '$.results',
  min: 1,
  weight: 1,
};

function capturingPolicies(): { service: DecisionPolicyService; inputs: RegisterPolicyInput[] } {
  const inputs: RegisterPolicyInput[] = [];
  const service = {
    register: async (input: RegisterPolicyInput) => {
      inputs.push(input);
      return { ...input.draft, version: 1 };
    },
  } as unknown as DecisionPolicyService;
  return { service, inputs };
}

describe('defaultDecisionPolicy', () => {
  it('gives the rules provider tools are registered with', () => {
    expect(defaultDecisionPolicy({ id: 'p', toolId: 't', withRules: true })).toEqual({
      id: 'p',
      toolId: 't',
      verifiers: [
        { verifierId: 'schema', label: 'Response shape' },
        { verifierId: 'rules', label: 'Declared rules' },
      ],
      clauses: PROVIDER_CLAUSES_WITH_RULES,
      otherwise: VerdictStatus.PASS,
    });
  });

  it('is shape only without declared rules', () => {
    const policy = defaultDecisionPolicy({ id: 'p', toolId: 't', withRules: false });
    expect(policy.verifiers).toEqual([{ verifierId: 'schema', label: 'Response shape' }]);
    expect(policy.clauses).toEqual(
      PROVIDER_CLAUSES_WITH_RULES.filter((clause) => clause.verifierId !== 'rules'),
    );
  });

  it('is what the provider-tool policy service registers, in SHADOW', async () => {
    const { service, inputs } = capturingPolicies();
    await new ProviderToolPolicyService(service).registerShadow({
      toolId: 't1',
      toolName: 'acme__search',
      organizationId: 'org-1',
      rules: [RULE],
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      startIn: PolicyLifecycle.SHADOW,
      createdBy: 'provider:org-1',
      draft: {
        id: 'provider-tool:t1',
        toolId: 't1',
        clauses: PROVIDER_CLAUSES_WITH_RULES,
        otherwise: VerdictStatus.PASS,
      },
      verificationPolicy: {
        id: 'provider-tool:t1',
        rules: [RULE],
        passThreshold: 0.7,
        mode: PolicyMode.SHADOW,
        crossCheck: { enabled: false },
        semantic: { enabled: false },
      },
    });
  });

  it('gives a standard tool the same clauses, its rules worded as the tool’s own', () => {
    const input = standardShadowInput({
      toolId: 't1',
      toolName: 'get_weather',
      rules: [RULE as never],
      passThreshold: 0.9,
      createdBy: 'op-1',
    });
    expect(input.startIn).toBe(PolicyLifecycle.SHADOW);
    expect(input.createdBy).toBe('op-1');
    expect(input.draft.id).toBe('get_weather.default');
    expect(input.draft.clauses.map((clause) => ({ ...clause, label: undefined }))).toEqual(
      PROVIDER_CLAUSES_WITH_RULES.map((clause) => ({ ...clause, label: undefined })),
    );
    expect(input.draft.clauses[2].label).toBe('The response broke a rule set for this tool.');
    expect(input.verificationPolicy).toMatchObject({ passThreshold: 0.9, rules: [RULE] });
  });
});

describe('registerDefaultShadowIfNone (P-10)', () => {
  const manager = (count: number) =>
    ({ count: jest.fn(async () => count) }) as unknown as EntityManager;

  it('registers a shape-only trial policy, authored by the system, through the manager', async () => {
    const register = jest.fn(async (input: RegisterPolicyInput) => ({
      ...input.draft,
      version: 1,
    }));
    const tx = manager(0);
    const policy = await registerDefaultShadowIfNone(
      { register } as unknown as DecisionPolicyService,
      tx,
      { id: 't1', name: 'get_weather' },
    );
    expect(policy).toMatchObject({ id: 'get_weather.default', version: 1 });
    const [input, passedManager] = register.mock.calls[0] as unknown as [
      RegisterPolicyInput,
      EntityManager,
    ];
    expect(passedManager).toBe(tx);
    expect(input.createdBy).toBe(AUTO_POLICY_AUTHOR);
    expect(input.startIn).toBe(PolicyLifecycle.SHADOW);
    expect(input.draft.verifiers.map((v) => v.verifierId)).toEqual(['schema']);
    expect(input.verificationPolicy?.rules).toEqual([]);
  });

  it('is idempotent: a tool with any policy row is left alone', async () => {
    const register = jest.fn();
    expect(
      await registerDefaultShadowIfNone(
        { register } as unknown as DecisionPolicyService,
        manager(1),
        { id: 't1', name: 'get_weather' },
      ),
    ).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });
});
