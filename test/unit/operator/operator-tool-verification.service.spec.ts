import { EntityManager, QueryRunner } from 'typeorm';

import { VerificationPolicyEntity } from '@database/postgres/entities/verification-policy.entity';
import {
  ApprovalMode,
  OperatorRole,
  lookupOverride,
} from '@modules/operator/domain/override-register';
import { ApprovalQueuedDto } from '@modules/operator/dto/operator-approval.dto';
import { OperatorErrorCode, OperatorErrors } from '@modules/operator/errors/operator.errors';
import { OperatorApprover, OperatorSession } from '@modules/operator/ports/operator-session.port';
import { OverrideContext } from '@modules/operator/services/override-log.service';
import {
  OperatorToolVerificationService,
  PROMOTE_POLICY_APPROVAL_ACTION,
} from '@modules/operator/services/operator-tool-verification.service';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { PolicyLifecycle } from '@modules/verification/domain/aggregation';
import { KillScope } from '@modules/verification/domain/lifecycle/kill-switch';
import { PromotionRefusal } from '@modules/verification/domain/lifecycle/promotion';
import {
  VerificationErrorCode,
  VerificationErrors,
} from '@modules/verification/errors/verification.errors';
import { RegisterPolicyInput } from '@modules/verification/services/decision-policy.service';
import { MeasuredEvidence } from '@modules/verification/services/policy-evidence.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

const TOOL_ID = '11111111-1111-4111-8111-111111111111';
const NOTE = 'Trial evidence reviewed with the policy team.';
const BODY = { reasonCode: 'POLICY_CHANGE', note: NOTE };

const session = (operatorId: string, roles: OperatorRole[]): OperatorSession => ({
  operatorId,
  subject: `${operatorId}@`,
  displayName: operatorId,
  email: `${operatorId}@example.test`,
  roles,
  authorityLimitMinor: null,
});
const REQUESTER = session('pol-1', [OperatorRole.POL]);
const APPROVER: OperatorApprover = {
  ...session('pola-1', [OperatorRole.POLA]),
  approvalId: 'approval-1',
};

const ENOUGH: MeasuredEvidence = {
  shadowCalls: 600,
  labelledSamples: 120,
  falsePositives: 1,
  falsePositiveRate: 1 / 120,
  unlabelledFails: 0,
  labellers: { 'adj-1': 120 },
  source: 'verification_records',
  computedAt: new Date(0).toISOString(),
};
const SHORT: MeasuredEvidence = {
  ...ENOUGH,
  shadowCalls: 40,
  labelledSamples: 10,
  falsePositives: 1,
  falsePositiveRate: 0.1,
};

function policyRow(overrides: Partial<VerificationPolicyEntity> = {}): VerificationPolicyEntity {
  return {
    policyId: 'get_x.default',
    policyVersion: 2,
    toolId: TOOL_ID,
    lifecycle: 'SHADOW',
    createdBy: 'author-1',
    decisionDocument: {},
    verificationDocument: { rules: [], passThreshold: 0.7 },
    promotedAt: null,
    promotedBy: null,
    promotionEvidence: null,
    withdrawnAt: null,
    withdrawnBy: null,
    withdrawnReason: null,
    createdAt: new Date(0),
    ...overrides,
  } as VerificationPolicyEntity;
}

function build(options: {
  readonly kind?: string;
  readonly rows?: VerificationPolicyEntity[];
  readonly evidence?: MeasuredEvidence;
  readonly failPerform?: Error;
}) {
  const rows = options.rows ?? [policyRow()];
  const tool = { id: TOOL_ID, name: 'get_x', kind: options.kind ?? 'STANDARD', status: 'ACTIVE' };
  const performed: OverrideContext[] = [];
  const changes = { contractsChanged: jest.fn(async () => undefined) };
  const policies = {
    resolveForTraffic: jest.fn(async () => null),
    register: jest.fn(async (input: RegisterPolicyInput) => ({ ...input.draft, version: 3 })),
    promote: jest.fn(async () => undefined),
    withdraw: jest.fn(async (policyId: string, version: number, reason: string, actor: string) => ({
      key: `policy:${policyId}@${version}`,
      scope: KillScope.POLICY_VERSION,
      policyId,
      version,
      reason,
      actor,
      killedAt: new Date(0).toISOString(),
    })),
  };
  const evidence = {
    evidenceFor: jest.fn(async () => options.evidence ?? ENOUGH),
  };
  const manager = {
    findOne: async () => null,
    createQueryBuilder: () => ({
      setLock: () => ({ where: () => ({ getOne: async () => tool }) }),
    }),
  } as unknown as EntityManager;
  const overrides = {
    perform: jest.fn(
      async (
        context: OverrideContext,
        mutation: (runner: QueryRunner) => Promise<{ value: unknown }>,
      ) => {
        const definition = lookupOverride(context.code)!;
        if (definition.approval === ApprovalMode.TWO_PERSON && !context.approver) {
          throw OperatorErrors.secondApproverRequired({ code: context.code });
        }
        performed.push(context);
        const result = await mutation({ manager } as unknown as QueryRunner);
        if (options.failPerform) throw options.failPerform;
        return result.value;
      },
    ),
  };
  const queued: Record<string, unknown>[] = [];
  const approvals = {
    register: jest.fn(),
    orQueue: async (request: { payload: Record<string, unknown> }, attempt: () => unknown) => {
      try {
        return await attempt();
      } catch (error) {
        if ((error as { errorCode?: string }).errorCode !== 'OPERATOR_SECOND_APPROVER_REQUIRED') {
          throw error;
        }
        queued.push(request.payload);
        return Object.assign(new ApprovalQueuedDto(), { approvalId: 'approval-1' });
      }
    },
  };
  const service = new OperatorToolVerificationService(
    { findOne: async () => tool } as never,
    {
      find: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter(
          (row) =>
            (where.policyVersion === undefined || row.policyVersion === where.policyVersion) &&
            (where.policyId === undefined || row.policyId === where.policyId),
        ),
      findServing: async () => rows[0] ?? null,
    } as never,
    policies as never,
    evidence as never,
    overrides as never,
    approvals as never,
    { find: async () => [] } as never,
    changes,
  );
  return { service, policies, evidence, overrides, performed, queued, changes, manager, approvals };
}

describe('OperatorToolVerificationService — P-1 promote', () => {
  it('registers its approval action as P-1', () => {
    const { approvals } = build({});
    expect(approvals.register).toHaveBeenCalledWith(
      PROMOTE_POLICY_APPROVAL_ACTION,
      expect.objectContaining({ code: 'P-1' }),
    );
  });

  it('refuses at once, with every unmet bar, when the measured evidence is short', async () => {
    const { service, overrides, policies } = build({ evidence: SHORT });
    const error = await service.promote(REQUESTER, TOOL_ID, 2, BODY, null).catch((e) => e);
    expect(error.errorCode).toBe(VerificationErrorCode.VERIFICATION_POLICY_PROMOTION_REFUSED);
    const codes = (error.context.failures as { code: string }[]).map((f) => f.code);
    expect(codes).toEqual([
      PromotionRefusal.INSUFFICIENT_SHADOW_CALLS,
      PromotionRefusal.INSUFFICIENT_LABELLED_SAMPLES,
      PromotionRefusal.FALSE_POSITIVE_RATE_TOO_HIGH,
    ]);
    // On the wire for the console.
    expect(error.publicContext.failures).toHaveLength(3);
    expect(overrides.perform).not.toHaveBeenCalled();
    expect(policies.promote).not.toHaveBeenCalled();
  });

  it('queues for a second operator when the evidence is enough, promoting nothing', async () => {
    const { service, queued, policies } = build({});
    const result = await service.promote(REQUESTER, TOOL_ID, 2, BODY, null);
    expect(result).toBeInstanceOf(ApprovalQueuedDto);
    expect(queued).toEqual([
      { toolId: TOOL_ID, policyId: 'get_x.default', version: 2, body: BODY },
    ]);
    expect(policies.promote).not.toHaveBeenCalled();
  });

  it('promotes on approval, on evidence counted again in the transaction', async () => {
    const { service, policies, evidence, performed, changes } = build({});
    await service.promote(REQUESTER, TOOL_ID, 2, BODY, 'req-1', APPROVER, 'get_x.default');

    expect(performed[0]).toMatchObject({
      code: 'P-1',
      approver: APPROVER,
      targetType: 'verification_policy',
      targetId: 'get_x.default@2',
      organizationId: null,
    });
    // Once before the override, then inside it through its manager.
    expect(evidence.evidenceFor).toHaveBeenNthCalledWith(1, 'get_x.default', 2);
    expect(evidence.evidenceFor).toHaveBeenNthCalledWith(2, 'get_x.default', 2, expect.anything());
    const [policyId, version, stored, manager] = policies.promote.mock.calls[0] as unknown as [
      string,
      number,
      Record<string, unknown>,
      EntityManager,
    ];
    expect([policyId, version]).toEqual(['get_x.default', 2]);
    expect(manager).toBeDefined();
    expect(stored).toMatchObject({
      shadowCalls: 600,
      labelledSamples: 120,
      falsePositives: 1,
      requestedBy: 'pol-1',
      approvedBy: 'pola-1',
      note: NOTE,
      source: 'verification_records',
      labellers: { 'adj-1': 120 },
    });
    expect(changes.contractsChanged).toHaveBeenCalled();
  });

  it('refuses an approver who wrote the policy', async () => {
    const { service, policies } = build({ rows: [policyRow({ createdBy: 'pola-1' })] });
    await expectErrorCodeAsync(
      () => service.promote(REQUESTER, TOOL_ID, 2, BODY, null, APPROVER, 'get_x.default'),
      OperatorErrorCode.OPERATOR_SELF_APPROVAL_REFUSED,
    );
    expect(policies.promote).not.toHaveBeenCalled();
  });

  it('reports a promotion that lost the race, and signals nothing', async () => {
    const { service, policies, changes } = build({});
    policies.promote.mockRejectedValueOnce(
      VerificationErrors.policyTransitionLost({ policyId: 'get_x.default', version: 2 }),
    );
    await expectErrorCodeAsync(
      () => service.promote(REQUESTER, TOOL_ID, 2, BODY, null, APPROVER, 'get_x.default'),
      VerificationErrorCode.VERIFICATION_POLICY_TRANSITION_LOST,
    );
    expect(changes.contractsChanged).not.toHaveBeenCalled();
  });

  it('answers nothing when the override-log entry fails (the transaction rolls back)', async () => {
    const { service, changes } = build({ failPerform: new Error('entry not written') });
    await expect(
      service.promote(REQUESTER, TOOL_ID, 2, BODY, null, APPROVER, 'get_x.default'),
    ).rejects.toThrow('entry not written');
    expect(changes.contractsChanged).not.toHaveBeenCalled();
  });

  it('refuses a version that is not SHADOW', async () => {
    const { service } = build({ rows: [policyRow({ lifecycle: 'ACTIVE' })] });
    const error = await service.promote(REQUESTER, TOOL_ID, 2, BODY, null).catch((e) => e);
    expect(error.errorCode).toBe(VerificationErrorCode.VERIFICATION_POLICY_PROMOTION_REFUSED);
    expect(error.context.failures.map((f: { code: string }) => f.code)).toContain(
      PromotionRefusal.NOT_IN_SHADOW,
    );
  });
});

describe('OperatorToolVerificationService — P-2 register', () => {
  it('registers a SHADOW policy through the override transaction, authored by the operator', async () => {
    const { service, policies, performed, changes } = build({});
    const rules = [
      { id: 'has_results', type: 'MIN_ARRAY_LENGTH', path: '$.results', min: 1, weight: 1 },
    ];
    await service.register(REQUESTER, TOOL_ID, { ...BODY, rules, passThreshold: 0.8 }, null);

    expect(performed[0]).toMatchObject({ code: 'P-2', targetType: 'tool', targetId: TOOL_ID });
    const [input, manager] = policies.register.mock.calls[0] as unknown as [
      RegisterPolicyInput,
      EntityManager,
    ];
    expect(manager).toBeDefined();
    expect(input).toMatchObject({
      createdBy: 'pol-1',
      startIn: PolicyLifecycle.SHADOW,
      draft: { id: 'get_x.default', toolId: TOOL_ID },
      verificationPolicy: { rules, passThreshold: 0.8 },
    });
    expect(changes.contractsChanged).toHaveBeenCalled();
  });

  it('refuses rules with problems, listing every one', async () => {
    const { service, overrides } = build({});
    const error = await service
      .register(REQUESTER, TOOL_ID, { ...BODY, rules: [{ id: 'X', type: 'NOPE' }] }, null)
      .catch((e) => e);
    expect(error.errorCode).toBe(VerificationErrorCode.VERIFICATION_POLICY_RULES_INVALID);
    expect(error.publicContext.problems.length).toBeGreaterThanOrEqual(2);
    expect(overrides.perform).not.toHaveBeenCalled();
  });

  it('refuses a provider tool: its policy comes from its published version', async () => {
    const { service, overrides } = build({ kind: 'PROVIDER' });
    await expectErrorCodeAsync(
      () => service.register(REQUESTER, TOOL_ID, BODY, null),
      ToolErrorCode.TOOL_CONTRACT_STATE,
    );
    expect(overrides.perform).not.toHaveBeenCalled();
  });
});

describe('OperatorToolVerificationService — P-3 withdraw', () => {
  it('engages the kill switch and moves the row inside the override transaction', async () => {
    const { service, policies, performed, changes } = build({
      rows: [policyRow({ lifecycle: 'ACTIVE' })],
    });
    await service.withdraw(REQUESTER, TOOL_ID, 2, BODY, null);
    expect(performed[0]).toMatchObject({ code: 'P-3', targetId: 'get_x.default@2' });
    expect(policies.withdraw).toHaveBeenCalledWith(
      'get_x.default',
      2,
      NOTE,
      'pol-1',
      expect.anything(),
    );
    expect(changes.contractsChanged).toHaveBeenCalled();
  });

  it('refuses a version that is neither ACTIVE nor SHADOW', async () => {
    const { service, policies } = build({ rows: [policyRow({ lifecycle: 'ARCHIVED' })] });
    await expectErrorCodeAsync(
      () => service.withdraw(REQUESTER, TOOL_ID, 2, BODY, null),
      ToolErrorCode.TOOL_CONTRACT_STATE,
    );
    expect(policies.withdraw).not.toHaveBeenCalled();
  });
});

describe('the policy rows of the override register', () => {
  it('P-1 is two-person, POL/POLA, approved by POLA, not reversible', () => {
    expect(lookupOverride('P-1')).toMatchObject({
      action: 'policy.promoted',
      roles: [OperatorRole.POL, OperatorRole.POLA],
      approval: ApprovalMode.TWO_PERSON,
      approverRoles: [OperatorRole.POLA],
      reversible: false,
      implemented: true,
    });
  });

  it('P-2 is one operator, POL/POLA, reversible', () => {
    expect(lookupOverride('P-2')).toMatchObject({
      action: 'policy.shadow_registered',
      roles: [OperatorRole.POL, OperatorRole.POLA],
      approval: ApprovalMode.SINGLE,
      reversible: true,
      implemented: true,
    });
  });

  it('P-3 is the built kill switch, a single-operator emergency action', () => {
    expect(lookupOverride('P-3')).toMatchObject({
      label: 'Withdraw a policy (kill switch)',
      roles: [OperatorRole.POL, OperatorRole.POLA, OperatorRole.SRE],
      approval: ApprovalMode.BREAK_GLASS,
      implemented: true,
    });
  });
});
