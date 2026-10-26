import { Inject, Injectable, Logger } from '@nestjs/common';
import { In, MoreThan } from 'typeorm';

import { VerificationPolicyEntity } from '@database/postgres/entities/verification-policy.entity';
import { VerificationRecordEntity } from '@database/postgres/entities/verification-record.entity';
import { ToolEntity } from '@database/postgres/entities/tool.entity';
import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { OperatorApprovalRepository } from '@database/postgres/repositories/operator-approval.repository';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { VerificationPolicyRepository } from '@database/postgres/repositories/verification-policy.repository';
import {
  asDeclaredRules,
  declaredRuleProblems,
} from '@modules/provider-tool/domain/declared-rules';
import { ToolErrors } from '@modules/tool/errors/tool.errors';
import {
  TOOL_CONTRACT_CHANGES,
  ToolContractChanges,
} from '@modules/tool/ports/tool-contracts.port';
import { ToolKind, ToolStatus } from '@modules/tool/ports/tool.types';
import { PolicyLifecycle } from '@modules/verification/domain/aggregation/decision-policy.types';
import {
  PROMOTION_GATE,
  PromotionRefusal,
  evaluatePromotion,
} from '@modules/verification/domain/lifecycle/promotion';
import { VerificationPolicy } from '@modules/verification/domain/policy.types';
import { VerificationErrors } from '@modules/verification/errors/verification.errors';
import { DecisionPolicyService } from '@modules/verification/services/decision-policy.service';
import {
  ComputedPromotionEvidence,
  MeasuredEvidence,
  PolicyEvidenceService,
} from '@modules/verification/services/policy-evidence.service';

import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import { ContractActionBodyDto } from '../dto/operator-contracts.dto';
import {
  LabelRecordBodyDto,
  ListTrialRecordsQueryDto,
  OperatorToolVerificationDto,
  PolicyVersionDto,
  RegisterPolicyBodyDto,
  TrialRecordDto,
  TrialRecordPageDto,
  WithdrawPolicyBodyDto,
} from '../dto/operator-verification.dto';
import { OperatorErrors } from '../errors/operator.errors';
import { OperatorApprover, OperatorSession } from '../ports/operator-session.port';
import { OperatorApprovalService } from './operator-approval.service';
import { lockTool } from './operator-contracts.service';
import { OverrideLogService } from './override-log.service';
import { standardShadowInput } from './standard-tool-policy';

export const PROMOTE_POLICY_APPROVAL_ACTION = 'policy.promote';

/** Trial records per page of the labelling queue. */
export const TRIAL_RECORDS_PAGE = 25;

/**
 * Stands in for the approver while a promotion is only being requested: the
 * gate's approver rule is checked again, for real, when someone approves.
 */
const PENDING_APPROVER = 'pending-second-operator';

/**
 * A tool's verification policies from the operator console (design: "operator
 * paths for verification policies"):
 *
 * ```text
 * (none) ──P-2 register──▶ SHADOW ──P-1 promote (two-person, measured gate)──▶ ACTIVE
 *                           │                                                  │
 *                           └────────────P-3 withdraw (kill switch)────────────┴──▶ WITHDRAWN
 * ```
 *
 * The gate's numbers are always counted by the server from the trial calls
 * and their labels, when the promotion is asked and again when it is
 * approved. Every write goes through the override log's transaction.
 */
@Injectable()
export class OperatorToolVerificationService {
  private readonly logger = new Logger(OperatorToolVerificationService.name);

  constructor(
    private readonly tools: ToolRepository,
    private readonly policyRows: VerificationPolicyRepository,
    private readonly policies: DecisionPolicyService,
    private readonly evidence: PolicyEvidenceService,
    private readonly overrides: OverrideLogService,
    private readonly approvals: OperatorApprovalService,
    private readonly approvalRows: OperatorApprovalRepository,
    @Inject(TOOL_CONTRACT_CHANGES) private readonly changes: ToolContractChanges,
  ) {
    approvals.register(PROMOTE_POLICY_APPROVAL_ACTION, {
      code: 'P-1',
      run: (requester, approver, payload, requestId) =>
        this.promote(
          requester,
          payload.toolId as string,
          payload.version as number,
          payload.body as ContractActionBodyDto,
          requestId,
          approver,
          payload.policyId as string,
        ),
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async get(toolId: string): Promise<OperatorToolVerificationDto> {
    const tool = await this.requireTool(toolId);
    const rows = await this.policyRows.find({
      where: { toolId: tool.id },
      order: { createdAt: 'DESC', policyVersion: 'DESC' },
    });
    const serving = await this.policies.resolveForTraffic(tool.id);
    const pending = rows.length
      ? await this.approvalRows.find({
          where: {
            action: PROMOTE_POLICY_APPROVAL_ACTION,
            status: 'PENDING',
            target: In(rows.map(targetOf)),
            expiresAt: MoreThan(new Date()),
          },
        })
      : [];
    const versions: PolicyVersionDto[] = [];
    for (const row of rows) {
      versions.push(
        versionDtoOf(
          row,
          await this.evidence.evidenceFor(row.policyId, row.policyVersion),
          pending.find((approval) => approval.target === targetOf(row))?.id ?? null,
        ),
      );
    }
    return {
      toolId: tool.id,
      toolName: tool.name,
      kind: tool.kind,
      checks: rows.some((row) => row.lifecycle === PolicyLifecycle.ACTIVE)
        ? 'ACTIVE'
        : rows.some((row) => row.lifecycle === PolicyLifecycle.SHADOW)
          ? 'SHADOW'
          : 'NONE',
      canRegister: tool.kind === ToolKind.STANDARD && tool.status !== ToolStatus.REMOVED,
      serving: serving
        ? {
            policyId: serving.decisionPolicy.id,
            version: serving.decisionPolicy.version,
            lifecycle: serving.lifecycle,
          }
        : null,
      versions,
      gate: { ...PROMOTION_GATE },
    };
  }

  async listRecords(
    toolId: string,
    version: number,
    query: ListTrialRecordsQueryDto,
  ): Promise<TrialRecordPageDto> {
    const row = await this.requireVersion(await this.requireTool(toolId), version);
    const page = await this.evidence.listShadowRecords({
      policyId: row.policyId,
      version: row.policyVersion,
      labelled: query.labelled,
      cursor: query.cursor,
      limit: TRIAL_RECORDS_PAGE,
    });
    return { records: page.records.map(recordDtoOf), nextCursor: page.nextCursor };
  }

  // ── Labels (not an override: no money, no policy change) ──────────────────

  async label(
    operator: OperatorSession,
    recordId: string,
    body: LabelRecordBodyDto,
  ): Promise<TrialRecordDto> {
    const record = await this.evidence.label({
      recordId,
      label: body.label,
      operatorId: operator.operatorId,
      note: body.note ?? null,
    });
    return recordDtoOf(record);
  }

  // ── P-2 register a trial policy (one operator) ────────────────────────────

  async register(
    operator: OperatorSession,
    toolId: string,
    body: RegisterPolicyBodyDto,
    requestId: string | null,
  ): Promise<OperatorToolVerificationDto> {
    const tool = await this.requireTool(toolId);
    if (tool.kind !== ToolKind.STANDARD) {
      throw ToolErrors.contractState({
        reason: 'a provider tool’s policy comes from its published version',
      });
    }
    if (tool.status === ToolStatus.REMOVED) {
      throw ToolErrors.contractState({ reason: 'this tool is removed' });
    }
    const problems = declaredRuleProblems(body.rules);
    if (problems.length > 0) throw VerificationErrors.policyRulesInvalid({ problems });
    const rules = asDeclaredRules(body.rules);

    try {
      const registered = await this.overrides.perform(
        {
          code: 'P-2',
          actor: operator,
          targetType: 'tool',
          targetId: tool.id,
          organizationId: null,
          reasonCode: body.reasonCode,
          reason: body.note,
          ticketRef: body.ticketRef ?? null,
          requestId,
        },
        async (queryRunner) => {
          const manager = queryRunner.manager;
          // Serializes with a publish (P-10), which may register one too.
          await lockTool(manager, tool.id);
          const previous = await manager.findOne(VerificationPolicyEntity, {
            where: { toolId: tool.id, lifecycle: PolicyLifecycle.SHADOW },
          });
          const policy = await this.policies.register(
            standardShadowInput({
              toolId: tool.id,
              toolName: tool.name,
              rules,
              passThreshold: body.passThreshold,
              emptyResult: body.emptyResult
                ? { whenUncorroborated: body.emptyResult.whenUncorroborated }
                : undefined,
              createdBy: operator.operatorId,
            }),
            manager,
          );
          return {
            value: policy,
            before: {
              shadow: previous ? `${previous.policyId}@${previous.policyVersion}` : null,
            },
            after: {
              policyId: policy.id,
              version: policy.version,
              lifecycle: PolicyLifecycle.SHADOW,
              rules: rules.length,
            },
          };
        },
      );
      this.logger.log(
        `${tool.name}: trial policy ${registered.id} v${registered.version} registered by ` +
          `operator ${operator.operatorId}`,
      );
    } catch (error) {
      if ((error as { code?: string })?.code === UNIQUE_VIOLATION_CODE) {
        throw ToolErrors.contractState({
          reason: 'another policy version was registered at the same time; reload and retry',
        });
      }
      throw error;
    }
    await this.changes.contractsChanged();
    return this.get(tool.id);
  }

  // ── P-1 promote (two-person, on measured evidence) ────────────────────────

  async promote(
    operator: OperatorSession,
    toolId: string,
    version: number,
    body: ContractActionBodyDto,
    requestId: string | null,
    approver: OperatorApprover | null = null,
    /** The queued request's policy, so an approval acts on exactly that one. */
    policyId?: string,
  ): Promise<OperatorToolVerificationDto | ApprovalQueuedDto> {
    const tool = await this.requireTool(toolId);
    const row = await this.requireVersion(tool, version, policyId);

    // Before queueing, so a request short of evidence is refused at once with
    // every unmet bar; the approver rule waits for a real approver.
    this.assertGate(row, await this.evidence.evidenceFor(row.policyId, row.policyVersion), {
      requestedBy: operator.operatorId,
      approvedBy: approver?.operatorId ?? PENDING_APPROVER,
    });
    if (approver && sameOperator(approver.operatorId, row.createdBy)) {
      throw OperatorErrors.selfApprovalRefused({ code: 'P-1' });
    }

    const attempt = async () => {
      await this.overrides.perform<void>(
        {
          code: 'P-1',
          actor: operator,
          approver,
          targetType: 'verification_policy',
          targetId: targetOf(row),
          organizationId: null,
          reasonCode: body.reasonCode,
          reason: body.note,
          ticketRef: body.ticketRef ?? null,
          requestId,
        },
        async (queryRunner) => {
          const manager = queryRunner.manager;
          // Counted again, in this transaction: what is stored is what the
          // approver approved on.
          const measured = await this.evidence.evidenceFor(
            row.policyId,
            row.policyVersion,
            manager,
          );
          const evidence: ComputedPromotionEvidence = {
            ...measured,
            requestedBy: operator.operatorId,
            approvedBy: approver?.operatorId ?? '',
            note: body.note,
          };
          await this.policies.promote(row.policyId, row.policyVersion, evidence, manager);
          return {
            value: undefined,
            before: { lifecycle: PolicyLifecycle.SHADOW },
            after: {
              lifecycle: PolicyLifecycle.ACTIVE,
              shadowCalls: measured.shadowCalls,
              labelledSamples: measured.labelledSamples,
              falsePositives: measured.falsePositives,
              falsePositiveRate: measured.falsePositiveRate,
            },
          };
        },
      );
      await this.changes.contractsChanged();
      this.logger.warn(`${tool.name}: ${targetOf(row)} switched on (ACTIVE)`);
      return this.get(tool.id);
    };

    if (approver) return attempt();
    return this.approvals.orQueue(
      {
        action: PROMOTE_POLICY_APPROVAL_ACTION,
        target: targetOf(row),
        payload: {
          toolId: tool.id,
          policyId: row.policyId,
          version: row.policyVersion,
          body: { ...body },
        },
        requester: operator,
      },
      attempt,
    );
  }

  // ── P-3 withdraw (kill switch, one operator) ──────────────────────────────

  async withdraw(
    operator: OperatorSession,
    toolId: string,
    version: number,
    body: WithdrawPolicyBodyDto,
    requestId: string | null,
  ): Promise<OperatorToolVerificationDto> {
    const tool = await this.requireTool(toolId);
    const row = await this.requireVersion(tool, version);
    if (row.lifecycle !== PolicyLifecycle.ACTIVE && row.lifecycle !== PolicyLifecycle.SHADOW) {
      throw ToolErrors.contractState({
        reason: `v${row.policyVersion} is ${row.lifecycle}; only an ACTIVE or SHADOW policy is withdrawn`,
      });
    }

    await this.overrides.perform<void>(
      {
        code: 'P-3',
        actor: operator,
        targetType: 'verification_policy',
        targetId: targetOf(row),
        organizationId: null,
        reasonCode: body.reasonCode,
        reason: body.note,
        ticketRef: body.ticketRef ?? null,
        requestId,
      },
      async (queryRunner) => {
        // The live switch first (every process stops applying it), then the
        // row in this transaction.
        const kill = await this.policies.withdraw(
          row.policyId,
          row.policyVersion,
          body.note,
          operator.operatorId,
          queryRunner.manager,
        );
        return {
          value: undefined,
          before: { lifecycle: row.lifecycle },
          after: { lifecycle: PolicyLifecycle.WITHDRAWN, killedAt: kill.killedAt },
        };
      },
    );
    await this.changes.contractsChanged();
    this.logger.warn(`${tool.name}: ${targetOf(row)} withdrawn by operator ${operator.operatorId}`);
    return this.get(tool.id);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private assertGate(
    row: VerificationPolicyEntity,
    measured: MeasuredEvidence,
    who: { readonly requestedBy: string; readonly approvedBy: string },
  ): void {
    const decision = evaluatePromotion(row.lifecycle as PolicyLifecycle, { ...measured, ...who });
    if (!decision.promotable) {
      throw VerificationErrors.policyPromotionRefused({
        policyId: row.policyId,
        version: row.policyVersion,
        reasons: decision.failures.map((failure) => failure.detail).join(' '),
        failures: decision.failures,
        falsePositiveRate: decision.falsePositiveRate,
      });
    }
  }

  private async requireTool(toolId: string): Promise<ToolEntity> {
    const row = await this.tools.findOne({ where: { id: toolId } });
    if (!row) throw ToolErrors.toolNotFound({ toolId });
    return row;
  }

  /**
   * The tool's policy row with this version. Versions are numbered per
   * policy id; a tool that was judged under more than one id (a seed's, then
   * its own) resolves to the serving one's, and is refused when still
   * ambiguous.
   */
  private async requireVersion(
    tool: ToolEntity,
    version: number,
    policyId?: string,
  ): Promise<VerificationPolicyEntity> {
    const rows = await this.policyRows.find({
      where: { toolId: tool.id, policyVersion: version, ...(policyId ? { policyId } : {}) },
    });
    if (rows.length === 1) return rows[0];
    if (rows.length === 0) {
      throw VerificationErrors.policyVersionNotFound({ policyId: policyId ?? tool.name, version });
    }
    const serving = await this.policyRows.findServing(tool.id);
    const match = rows.find((row) => row.policyId === serving?.policyId);
    if (!match) {
      throw ToolErrors.contractState({
        reason: `v${version} names more than one policy of this tool`,
      });
    }
    return match;
  }
}

function targetOf(row: { readonly policyId: string; readonly policyVersion: number }): string {
  return `${row.policyId}@${row.policyVersion}`;
}

function sameOperator(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function versionDtoOf(
  row: VerificationPolicyEntity,
  evidence: MeasuredEvidence,
  pendingApprovalId: string | null,
): PolicyVersionDto {
  const checks = row.verificationDocument as unknown as Partial<VerificationPolicy> | null;
  const shadow = row.lifecycle === PolicyLifecycle.SHADOW;
  const decision = shadow
    ? evaluatePromotion(PolicyLifecycle.SHADOW, {
        ...evidence,
        requestedBy: 'preview-requester',
        approvedBy: PENDING_APPROVER,
      })
    : null;
  return {
    policyId: row.policyId,
    version: row.policyVersion,
    lifecycle: row.lifecycle,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    rules: [...(checks?.rules ?? [])],
    passThreshold: checks?.passThreshold ?? null,
    emptyResult: checks?.emptyResult ?? null,
    evidence: { ...evidence, labellers: { ...evidence.labellers } },
    gate: decision
      ? {
          promotable: decision.promotable,
          failures: decision.failures
            .filter((failure) => failure.code !== PromotionRefusal.SELF_APPROVED)
            .map((failure) => ({ code: failure.code, detail: failure.detail })),
        }
      : null,
    pendingApprovalId,
    promotedAt: row.promotedAt,
    promotedBy: row.promotedBy,
    promotionEvidence: row.promotionEvidence,
    withdrawnAt: row.withdrawnAt,
    withdrawnBy: row.withdrawnBy,
    withdrawnReason: row.withdrawnReason,
  };
}

function recordDtoOf(record: VerificationRecordEntity): TrialRecordDto {
  return {
    id: record.id,
    intentId: record.intentId,
    providerId: record.providerId,
    createdAt: record.createdAt,
    request: record.request ?? null,
    response: record.response ?? null,
    verdictStatus: record.verdictStatus,
    reasonCode: record.reasonCode,
    reason: record.reason,
    stages: record.stages ?? null,
    decidedBy: record.decidedBy ?? null,
    label: record.label,
    labelledBy: record.labelledBy,
    labelledAt: record.labelledAt,
    labelNote: record.labelNote,
  };
}
