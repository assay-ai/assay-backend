import { Inject, Injectable } from '@nestjs/common';
import { Request } from 'express';

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
import { OperatorErrors } from '../errors/operator.errors';
import { AdjudicationQueueService } from './adjudication-queue.service';
import {
  OPERATOR_SESSION_SOURCE,
  OperatorSession,
  OperatorSessionPort,
} from '../ports/operator-session.port';

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
    @Inject(OPERATOR_SESSION_SOURCE) private readonly sessions: OperatorSessionPort,
  ) {}

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

  async suspend(
    operator: OperatorSession,
    proposalId: string,
    body: SuspendProposalBodyDto,
    requestId: string | null,
  ) {
    const organizationId = await this.tenantOf(proposalId);
    return this.arbitration.suspend(
      operator,
      organizationId,
      proposalId,
      body.reasonCode,
      body.note,
      body.ticketRef ?? null,
      requestId,
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

  async openSweep(
    operator: OperatorSession,
    proposalId: string,
    body: OpenFleetSweepBodyDto,
    request: Request,
    requestId: string | null,
  ): Promise<FleetSweepDto> {
    const organizationId = await this.tenantOf(proposalId);
    const approver = await this.resolveApprover(request, operator);
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
  }

  /** `S-5`, step one. Builds only — see `SlashExecutionService.compensationIntent`. */
  async compensationIntent(proposalId: string): Promise<SlashCompensationIntent> {
    const organizationId = await this.tenantOf(proposalId);
    return this.execution.compensationIntent(organizationId, proposalId);
  }

  /** `S-5`, step two. Two-person, and the signature is checked against the cluster. */
  async compensated(
    operator: OperatorSession,
    proposalId: string,
    body: CompensatedBodyDto,
    request: Request,
    requestId: string | null,
  ) {
    const organizationId = await this.tenantOf(proposalId);
    const approver = await this.resolveApprover(request, operator);
    return this.execution.markCompensated(
      operator,
      approver,
      organizationId,
      proposalId,
      body.signature,
      body.reasonCode,
      body.note,
      requestId,
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
   * The checker, for a two-person action.
   *
   * Supplied as a **second bearer token** in `X-Operator-Approver`, resolved
   * through the same credential source as the actor. Two properties follow, and
   * both matter:
   *
   * - The checker has to *authenticate*, so approval is an act by an identity
   *   rather than a name typed into a form. A body field naming an operator id
   *   would let one person approve as another by knowing their id.
   * - Nothing is stored between the two, so there is no pending-approval queue
   *   to leak or to time out.
   *
   * What it costs is that both people must be at the same keyboard, or one must
   * hand the other a token — which is a real operational limitation and is the
   * honest MVP of maker/checker rather than a claim to have built it.
   * The full workflow has the action sit in `PENDING` and do nothing until a
   * second identity approves it asynchronously; that needs a queue of pending
   * actions, which is not built yet.
   *
   * This resolves *who* the checker is: an authenticated, active operator
   * (`sessions.resolve` refuses a suspended one) who is not the actor. Whether
   * their **roles** qualify them is the register row's to say — `S-11` demands
   * `ADJ` or `ADJL`, `S-5` names none — and `OverrideLogService` enforces it,
   * so the rule cannot differ between two routes citing one code.
   */
  private async resolveApprover(
    request: Request,
    actor: OperatorSession,
  ): Promise<OperatorSession> {
    const header = request.headers['x-operator-approver'];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token) {
      throw OperatorErrors.secondApproverRequired({ code: 'two-person' });
    }

    const approver = await this.sessions.resolve(token);
    if (approver.operatorId === actor.operatorId) {
      throw OperatorErrors.selfApprovalRefused({ code: 'two-person' });
    }
    return approver;
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
