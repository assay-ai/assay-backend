import { Injectable, Optional } from '@nestjs/common';

import { EvmChainStateRepository } from '@database/postgres/repositories/evm-chain-state.repository';

import { SlashContractCall } from '@modules/slash/ports/slash-dispute-intent.port';
import {
  ArbiterIntentContext,
  SlashDisputeIntentService,
} from '@modules/slash/services/slash-dispute-intent.service';

import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import { OperatorApprover } from '../ports/operator-session.port';
import { OperatorErrors } from '../errors/operator.errors';
import { APPROVAL_TTL_MS, OperatorApprovalService } from './operator-approval.service';

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
    // The chain-state indexer's blocklist cache: whether the approved block
    // was carried out and then lifted. Optional: without it only the expiry
    // and the chain's own "already blocked" refusal apply.
    @Optional() private readonly chainState: EvmChainStateRepository | null = null,
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

  /**
   * Review N-5: the unsigned call of an APPROVED `A-11`, again — for the
   * arbiter's wallet on the arbiter page, after the approver's tab is gone.
   * Rebuilt deterministically from the approved payload; refused once the
   * address is blocked on chain (the call was executed).
   *
   * Review R2-7: also refused (409 `OPERATOR_APPROVAL_CALL_STALE`) once the
   * approval is older than the approvals' own expiry, `APPROVAL_TTL_MS` after
   * it was decided, and once the block it approved was carried out and later
   * lifted: the indexer's row for the address reads unblocked, written after
   * the decision. That reading is conservative — any write after the
   * decision counts — and its worst case is asking for a fresh `A-11`.
   */
  async approvedBlockCall(approvalId: string): Promise<SlashContractCall> {
    const row = await this.approvals.requireApproved(approvalId, ARBITER_BLOCK_APPROVAL_ACTION);
    const chainId = row.payload.chainId as string;
    const account = row.payload.account as string;
    const decidedAt = row.decidedAt ?? row.createdAt;
    if (!decidedAt || Date.now() - new Date(decidedAt).getTime() > APPROVAL_TTL_MS) {
      throw OperatorErrors.approvalCallStale({
        reason: `approved more than ${APPROVAL_TTL_MS / 3_600_000} hours ago`,
      });
    }
    const known = await this.chainState?.findBlockedAddress(chainId, account);
    if (known && !known.blocked && known.updatedAt.getTime() >= new Date(decidedAt).getTime()) {
      throw OperatorErrors.approvalCallStale({
        reason: 'the address was blocked on chain after this approval and has since been unblocked',
      });
    }
    return this.disputes.rebuildArbiterBlock(chainId, account);
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
