import { Injectable } from '@nestjs/common';

import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { CursorPageDto } from '@shared/api';
import { ArbitrationService } from '@modules/slash/services/arbitration.service';
import { SlashExecutionService } from '@modules/slash/services/slash-execution.service';
import { SlashErrors } from '@modules/slash/errors/slash.errors';
import {
  SlashCancelIntent,
  SlashCompensationIntent,
} from '@modules/slash/ports/slash-executor.port';

import {
  AdjudicationQueueRowDto,
  CompensatedBodyDto,
  DecideCaseBodyDto,
  ExtendDeadlineBodyDto,
  FleetSweepDto,
  ListQueueQueryDto,
  OpenFleetSweepBodyDto,
  SecondSignatureBodyDto,
  SuspendProposalBodyDto,
} from '../dto/operator-console.dto';
import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import { OperatorApprover, OperatorSession } from '../ports/operator-session.port';
import { AdjudicationQueueService } from './adjudication-queue.service';
import { OperatorApprovalService } from './operator-approval.service';

/** The queued-action names this service owns. */
export const CASE_APPROVAL_ACTIONS = {
  suspend: 'slash.suspend',
  sweep: 'slash.sweep',
  compensated: 'slash.compensated',
} as const;

/**
 * The operator's side of a case, and the one place a tenant is resolved from a
 * proposal id.
 *
 * ## Why the controller never passes an organization
 *
 * An adjudicator works from a queue that already spans tenants, so asking them
 * to supply the tenant would be asking them to re-state something they read off
 * our own screen — and a tenant a caller can state is a tenant a caller can
 * state wrongly. The proposal id is globally unique; this service resolves the
 * tenant from it once, and every write below is scoped to what it resolved.
 *
 * That is the opposite of the provider surface, where the tenant comes from the
 * session and the id is checked against it. Both are correct for their caller,
 * and mixing them would produce a known defect the other way round:
 * a query scoped to the wrong column, serving an empty list to somebody who
 * should have seen everything.
 */
@Injectable()
export class OperatorCaseService {
  constructor(
    private readonly proposals: SlashProposalRepository,
    private readonly queue: AdjudicationQueueService,
    private readonly arbitration: ArbitrationService,
    private readonly execution: SlashExecutionService,
    private readonly approvals: OperatorApprovalService,
  ) {
    // How an approved action is re-run: the same method, as the requester,
    // with the approver attached.
    approvals.register(CASE_APPROVAL_ACTIONS.suspend, {
      code: 'S-1',
      run: (requester, approver, payload, requestId) =>
        this.suspend(
          requester,
          payload.proposalId as string,
          payload.body as SuspendProposalBodyDto,
          requestId,
          approver,
        ),
    });
    approvals.register(CASE_APPROVAL_ACTIONS.sweep, {
      code: 'S-11',
      run: (requester, approver, payload, requestId) =>
        this.openSweep(
          requester,
          payload.proposalId as string,
          payload.body as OpenFleetSweepBodyDto,
          requestId,
          approver,
        ),
    });
    approvals.register(CASE_APPROVAL_ACTIONS.compensated, {
      code: 'S-5',
      run: (requester, approver, payload, requestId) =>
        this.compensated(
          requester,
          payload.proposalId as string,
          payload.body as CompensatedBodyDto,
          requestId,
          approver,
        ),
    });
  }

  async listQueue(
    operator: OperatorSession,
    query: ListQueueQueryDto,
  ): Promise<CursorPageDto<AdjudicationQueueRowDto>> {
    return this.queue.list(operator, query);
  }

  /**
   * The brief is the provider's own case object, plus the timeline, the
   * restoration record and whether a second signature is outstanding.
   *
   * The same object, deliberately. Every item an adjudicator needs is something
   * the provider is entitled to see too; building a second, richer
   * representation for us would mean the screen the provider argues against is
   * not the screen we decide from.
   */
  async brief(proposalId: string) {
    const organizationId = await this.tenantOf(proposalId);
    return this.queue.brief(organizationId, proposalId);
  }

  async claim(operator: OperatorSession, proposalId: string) {
    const organizationId = await this.tenantOf(proposalId);
    return this.arbitration.claim(operator, organizationId, proposalId);
  }

  async decide(
    operator: OperatorSession,
    proposalId: string,
    body: DecideCaseBodyDto,
    requestId: string | null,
  ) {
    const organizationId = await this.tenantOf(proposalId);
    return this.arbitration.decide(
      operator,
      organizationId,
      proposalId,
      {
        outcome: body.outcome,
        reasonCodes: body.reasonCodes,
        note: body.note,
        rootCauseKey: body.rootCauseKey ?? null,
        ticketRef: body.ticketRef ?? null,
        recalculatedAmount: body.recalculatedAmount ?? null,
      },
      requestId,
    );
  }

  async second(
    operator: OperatorSession,
    proposalId: string,
    body: SecondSignatureBodyDto,
    requestId: string | null,
  ) {
    const organizationId = await this.tenantOf(proposalId);
    return this.arbitration.second(
      operator,
      organizationId,
      proposalId,
      body.kind,
      body.note,
      requestId,
    );
  }

  /**
   * `S-1`. One person from `PROPOSED`, `DISPUTED` and `UNDER_REVIEW`; from
   * `AWAITING_SECOND` and `UPHELD` the register raises it to two-person, and a
   * call without an approver is queued (`ApprovalQueuedDto`, HTTP 202).
   */
  async suspend(
    operator: OperatorSession,
    proposalId: string,
    body: SuspendProposalBodyDto,
    requestId: string | null,
    approver: OperatorApprover | null = null,
  ) {
    const organizationId = await this.tenantOf(proposalId);
    const attempt = () =>
      this.arbitration.suspend(
        operator,
        organizationId,
        proposalId,
        body.reasonCode,
        body.note,
        body.ticketRef ?? null,
        requestId,
        approver,
      );
    if (approver) return attempt();
    return this.approvals.orQueue(
      {
        action: CASE_APPROVAL_ACTIONS.suspend,
        target: `slash_proposal:${proposalId}`,
        payload: { proposalId, body: { ...body } },
        requester: operator,
      },
      attempt,
    );
  }

  async extendDeadline(
    operator: OperatorSession,
    proposalId: string,
    body: ExtendDeadlineBodyDto,
    requestId: string | null,
  ) {
    const organizationId = await this.tenantOf(proposalId);
    return this.arbitration.extendDeadline(
      operator,
      organizationId,
      proposalId,
      body.additionalHours,
      body.reasonCode,
      body.note,
      requestId,
    );
  }

  /** `S-11`. Always two-person: called without an approver, it is queued. */
  async openSweep(
    operator: OperatorSession,
    proposalId: string,
    body: OpenFleetSweepBodyDto,
    requestId: string | null,
    approver: OperatorApprover | null = null,
  ): Promise<FleetSweepDto | ApprovalQueuedDto> {
    const organizationId = await this.tenantOf(proposalId);
    const attempt = async (): Promise<FleetSweepDto> => {
      const sweep = await this.execution.openSweep(
        operator,
        approver,
        organizationId,
        proposalId,
        body,
        requestId,
      );
      return {
        id: sweep.id,
        outcome: sweep.outcome as FleetSweepDto['outcome'],
        defectKey: sweep.defectKey,
        windowFrom: sweep.windowFrom,
        windowTo: sweep.windowTo,
        status: sweep.status as FleetSweepDto['status'],
        matchedCount: sweep.matchedCount,
        appliedCount: sweep.appliedCount,
        openedBySubject: operator.subject,
        completedAt: sweep.completedAt,
      };
    };
    if (approver) return attempt();
    return this.approvals.orQueue(
      {
        action: CASE_APPROVAL_ACTIONS.sweep,
        target: `slash_proposal:${proposalId}`,
        payload: { proposalId, body: { ...body } },
        requester: operator,
      },
      attempt,
    );
  }

  /** `S-5`, step one. Builds only — see `SlashExecutionService.compensationIntent`. */
  async compensationIntent(proposalId: string): Promise<SlashCompensationIntent> {
    const organizationId = await this.tenantOf(proposalId);
    return this.execution.compensationIntent(organizationId, proposalId);
  }

  /**
   * `S-5`, step two. Two-person: called without an approver it is queued,
   * after the deposit has been checked against the chain; the approval checks
   * it again.
   */
  async compensated(
    operator: OperatorSession,
    proposalId: string,
    body: CompensatedBodyDto,
    requestId: string | null,
    approver: OperatorApprover | null = null,
  ) {
    const organizationId = await this.tenantOf(proposalId);
    const attempt = () =>
      this.execution.markCompensated(
        operator,
        approver,
        organizationId,
        proposalId,
        body.signature,
        body.reasonCode,
        body.note,
        requestId,
      );
    if (approver) return attempt();
    return this.approvals.orQueue(
      {
        action: CASE_APPROVAL_ACTIONS.compensated,
        target: `slash_proposal:${proposalId}`,
        payload: { proposalId, body: { ...body } },
        requester: operator,
      },
      attempt,
    );
  }

  /**
   * The settlement admin's unsigned `cancel_slash`. Builds only.
   *
   * Not two-person and not an override: it writes nothing. The decision that
   * put the case into `CANCEL_REQUESTED` was the override.
   */
  async cancelIntent(proposalId: string): Promise<SlashCancelIntent> {
    const organizationId = await this.tenantOf(proposalId);
    return this.execution.buildCancelIntent(organizationId, proposalId);
  }

  /**
   * The proposal's tenant, looked up across tenants.
   *
   * A 404 here is indistinguishable from "no such proposal", which is correct:
   * an operator asking for an id that does not exist and an operator asking for
   * one that was deleted should learn the same thing.
   */
  private async tenantOf(proposalId: string): Promise<string> {
    const organizationId = await this.proposals.tenantOf(proposalId);
    if (!organizationId) {
      throw SlashErrors.proposalNotFound({ proposalId });
    }
    return organizationId;
  }
}
