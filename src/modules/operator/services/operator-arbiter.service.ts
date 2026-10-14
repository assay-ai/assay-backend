import { Injectable } from '@nestjs/common';

import { SlashContractCall } from '@modules/slash/ports/slash-dispute-intent.port';
import {
  ArbiterIntentContext,
  SlashDisputeIntentService,
} from '@modules/slash/services/slash-dispute-intent.service';

import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import { OperatorApprover } from '../ports/operator-session.port';
import { OperatorApprovalService } from './operator-approval.service';

export const ARBITER_BLOCK_APPROVAL_ACTION = 'arbiter.block';

/**
 * `A-11` through the approvals queue. The on-chain block freezes an address's
 * escrow until the cold admin unblocks it, so one operator may ask for it and a
 * second (`ADJL`) approves it; the approver receives the unsigned call for the
 * arbiter to sign. The call is built again at approval, against the chain as
 * it is then.
 */
@Injectable()
export class OperatorArbiterService {
  constructor(
    private readonly disputes: SlashDisputeIntentService,
    private readonly approvals: OperatorApprovalService,
  ) {
    approvals.register(ARBITER_BLOCK_APPROVAL_ACTION, {
      code: 'A-11',
      run: (requester, approver, payload, requestId) =>
        this.block(
          {
            operator: requester,
            reasonCode: payload.reasonCode as string,
            note: payload.note as string,
            ticketRef: (payload.ticketRef as string | null) ?? null,
            requestId,
          },
          payload.chainId as string,
          payload.account as string,
          approver,
        ),
    });
  }

  async block(
    context: ArbiterIntentContext,
    chainId: string,
    account: string,
    approver: OperatorApprover | null = null,
  ): Promise<SlashContractCall | ApprovalQueuedDto> {
    const attempt = () => this.disputes.arbiterBlock({ ...context, approver }, chainId, account);
    if (approver) return attempt();
    return this.approvals.orQueue(
      {
        action: ARBITER_BLOCK_APPROVAL_ACTION,
        target: `chain_blocklist:${chainId}:${account.toLowerCase()}`,
        payload: {
          chainId,
          account,
          reasonCode: context.reasonCode,
          note: context.note,
          ticketRef: context.ticketRef ?? null,
        },
        requester: context.operator,
      },
      attempt,
    );
  }
}
