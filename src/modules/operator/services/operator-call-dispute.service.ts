import { Injectable } from '@nestjs/common';

import { CallDisputeDecision, RefundState } from '@modules/dispute/domain/call-dispute';
import { OperatorCallDisputeDetailDto } from '@modules/dispute/dto/call-dispute.dto';
import {
  CALL_DISPUTE_TARGET,
  CallDisputeService,
  toDetail,
} from '@modules/dispute/services/call-dispute.service';
import { DisputeState } from '@modules/dispute/dto/dispute.dto';

import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import { OperatorApprover, OperatorSession } from '../ports/operator-session.port';
import { OperatorApprovalService } from './operator-approval.service';
import { OverrideLogService } from './override-log.service';

export const CALL_DISPUTE_DECIDE_APPROVAL_ACTION = 'call_dispute.decide';
export const CALL_DISPUTE_OVERRIDE_CODE = 'S-14';

export interface CallDisputeDecideRequest {
  readonly operator: OperatorSession;
  readonly disputeId: string;
  readonly decision: CallDisputeDecision;
  readonly note: string;
  readonly ticketRef?: string | null;
  readonly requestId?: string | null;
}

/**
 * The operator queue for buyer call disputes (G3.B1): the list, the case
 * detail, and the decision.
 *
 * A decision goes through the override register (`S-14`) in one transaction
 * with the dispute's compare-and-swap. An upheld decision owing at least the
 * configured threshold is raised to two-person: without an approver it is
 * queued (`OperatorApprovalService`), and the second operator's approval
 * re-runs it — re-reading where the call's money is at that moment, not when
 * it was queued. The money step runs after the commit
 * (`CallDisputeService.settleRefund`); deciding an upheld dispute whose refund
 * is still `PENDING` again runs only that step.
 */
@Injectable()
export class OperatorCallDisputeService {
  constructor(
    private readonly disputes: CallDisputeService,
    private readonly overrides: OverrideLogService,
    private readonly approvals: OperatorApprovalService,
  ) {
    approvals.register(CALL_DISPUTE_DECIDE_APPROVAL_ACTION, {
      code: CALL_DISPUTE_OVERRIDE_CODE,
      run: (requester, approver, payload, requestId) =>
        this.decide(
          {
            operator: requester,
            disputeId: payload.disputeId as string,
            decision: payload.decision as CallDisputeDecision,
            note: payload.note as string,
            ticketRef: (payload.ticketRef as string | null) ?? null,
            requestId,
          },
          approver,
        ),
    });
  }

  async detail(id: string): Promise<OperatorCallDisputeDetailDto> {
    const dispute = await this.disputes.requireAny(id);
    const [row, intent, history] = await Promise.all([
      this.disputes.operatorRow(dispute),
      this.disputes.intentSummary(dispute),
      this.overrides.historyFor(CALL_DISPUTE_TARGET, id),
    ]);
    return {
      ...row,
      evidence: toDetail(dispute).evidence,
      intent,
      resolvedBy: dispute.resolvedBy,
      secondedBy: dispute.secondedByOperatorId,
      history: history.map((entry) => ({
        code: entry.code,
        action: entry.action,
        actorOperatorId: entry.actorOperatorId,
        approverOperatorId: entry.approverOperatorId,
        createdAt: entry.createdAt,
      })),
    };
  }

  async decide(
    request: CallDisputeDecideRequest,
    approver: OperatorApprover | null = null,
  ): Promise<OperatorCallDisputeDetailDto | ApprovalQueuedDto> {
    const context = await this.disputes.decisionContext(request.disputeId, request.decision);

    // A decided upheld dispute whose money step did not land: finish it. The
    // decision itself was logged when it was taken.
    if (
      context.dispute.state === DisputeState.UPHELD &&
      context.dispute.refundState === RefundState.PENDING &&
      request.decision === CallDisputeDecision.UPHOLD
    ) {
      const settled = await this.disputes.settleRefund(request.disputeId);
      if (settled.refundState !== RefundState.PENDING) {
        await this.disputes.announceDecision(settled, { afterRefundRetry: true });
      }
      return this.detail(request.disputeId);
    }

    const attempt = async (): Promise<OperatorCallDisputeDetailDto> => {
      await this.overrides.perform(
        {
          code: CALL_DISPUTE_OVERRIDE_CODE,
          actor: request.operator,
          approver,
          targetType: CALL_DISPUTE_TARGET,
          targetId: request.disputeId,
          organizationId: context.dispute.organizationId,
          reasonCode: request.decision,
          reason: request.note,
          ticketRef: request.ticketRef ?? null,
          requestId: request.requestId ?? null,
          escalateToTwoPerson: context.needsSecondOperator,
          amountMinor: request.decision === CallDisputeDecision.UPHOLD ? context.amountMinor : null,
        },
        async (queryRunner) => {
          const result = await this.disputes.decideWithin(queryRunner, {
            disputeId: request.disputeId,
            decision: request.decision,
            note: request.note,
            operatorId: request.operator.operatorId,
            approverOperatorId: approver?.operatorId ?? null,
          });
          return { value: null, before: result.before, after: result.after };
        },
      );
      const settled = await this.disputes.settleRefund(request.disputeId);
      await this.disputes.announceDecision(settled);
      return this.detail(request.disputeId);
    };

    if (approver || !context.needsSecondOperator) return attempt();
    return this.approvals.orQueue(
      {
        action: CALL_DISPUTE_DECIDE_APPROVAL_ACTION,
        target: `${CALL_DISPUTE_TARGET}:${request.disputeId}`,
        payload: {
          disputeId: request.disputeId,
          decision: request.decision,
          note: request.note,
          ticketRef: request.ticketRef ?? null,
        },
        requester: request.operator,
      },
      attempt,
    );
  }
}
