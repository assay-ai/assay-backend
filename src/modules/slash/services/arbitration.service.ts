import { Injectable } from '@nestjs/common';
import { IsNull } from 'typeorm';

import { DisputeEntity } from '@database/postgres/entities/dispute.entity';
import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { DisputeRepository } from '@database/postgres/repositories/dispute.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';

import {
  ARBITRATION_STATE_MAP,
  ArbitrationOutcome,
  DisputeClaimType,
  DisputeResolutionState,
  ResolutionKind,
} from '../domain/arbitration';
import { SlashProposalStatus } from '../domain/slash-proposal-state';
import { SlashErrors } from '../errors/slash.errors';
import { SlashProposalService } from './slash-proposal.service';

/** The on-chain dispute, as `transitionIfIn`'s one-status list. */
const DISPUTED: readonly SlashProposalStatus[] = Object.freeze([SlashProposalStatus.DISPUTED]);

/**
 * Review R2-2 / R3-5: the statuses a case wrongly labelled `AUTO_UNDISPUTED`
 * reopens from when a dispute is mirrored after the label. `EXECUTING` too:
 * the executor's claim on a case whose every standing record is disputed
 * can only be refused on chain, and its return to `UPHELD` is never followed
 * again, so the label would stay wrong.
 */
const REOPENABLE_STATUSES: readonly SlashProposalStatus[] = Object.freeze([
  SlashProposalStatus.UPHELD,
  SlashProposalStatus.EXECUTING,
]);

/**
 * The case's side of the on-chain dispute (assay-evm D-19).
 *
 * The provider disputes with `disputeSlash` from its own stake wallet and the
 * person-held arbiter rules on chain; `SlashChainRulingService` mirrors those
 * events and calls in here to move the case and its dispute row. Nothing here
 * is an operator's decision: there is no off-chain claim, decision, second
 * signature, suspension or deadline extension, and an EVM case is the only
 * case that is disputed at all.
 *
 * ## Where the polarity flip is handled
 *
 * `disputes.state` describes what happened to the **objection**;
 * `slash_proposals.outcome` describes what happened to the **proposal**. They
 * point in opposite directions. `ARBITRATION_STATE_MAP` is the only place the
 * translation happens. Getting it backwards would tell a provider they won a
 * case they lost.
 */
@Injectable()
export class ArbitrationService {
  constructor(
    private readonly proposals: SlashProposalRepository,
    private readonly disputes: DisputeRepository,
    private readonly lifecycle: SlashProposalService,
  ) {}

  /**
   * The provider disputed the case's on-chain record (`disputeSlash`, assay-evm
   * D-19) while the case was still `PROPOSED`: the case becomes `DISPUTED`
   * and waits for the arbiter's on-chain ruling. No platform deadline is set
   * and none runs: the arbiter is the only judge, and an unruled dispute
   * expires on chain after 30 days. The chain already enforced its own window
   * (`executableAt`), so nothing off-chain is re-checked. Returns `null` when
   * the case is no longer `PROPOSED` or already has an objection.
   */
  async fileDisputeFromChain(
    organizationId: string,
    proposalId: string,
    chain: { readonly requestId: string; readonly transactionHash: string | null },
  ): Promise<SlashProposalEntity | null> {
    const proposal = await this.lifecycle.require(organizationId, proposalId);
    if (proposal.disputeId || proposal.status !== SlashProposalStatus.PROPOSED) return null;
    try {
      const { proposal: updated } = await this.openDispute(
        organizationId,
        proposalId,
        {
          reason:
            `Disputed on chain: the provider called disputeSlash on record ${chain.requestId}` +
            `${chain.transactionHash ? ` (transaction ${chain.transactionHash})` : ''}.`,
          openedBy: 'chain:disputeSlash',
        },
        chain,
      );
      return updated;
    } catch (error) {
      // Lost a race with the undisputed sweep.
      if ((error as { errorCode?: string })?.errorCode?.startsWith('SLASH_')) return null;
      throw error;
    }
  }

  /**
   * The arbiter upheld the case's disputed record on chain (`upholdSlash`):
   * that ruling is the decision (EVM has no off-chain one). The case becomes
   * `UPHELD` (`CHAIN_ARBITER`) so the executor sends it at the record's
   * `executableAt`, and its dispute closes as an upheld decision closes it.
   *
   * Review R2-2 / R2-10: a case the platform already labelled `UPHELD`
   * (`AUTO_UNDISPUTED`, written first by the undisputed sweep or by a sibling
   * event's {@link recordChainStanding}) is relabelled `CHAIN_ARBITER`: the
   * arbiter ruled, whatever was written first. The status is left as it is.
   * `arbiter` is `null` when the ruling is read off the records rather than
   * off its event. A case otherwise closed is left alone. Returns whether the
   * case moved or was relabelled.
   */
  async recordChainUphold(
    organizationId: string,
    proposalId: string,
    chain: { readonly arbiter: string | null; readonly transactionHash: string | null },
  ): Promise<boolean> {
    const proposal = await this.lifecycle.require(organizationId, proposalId);
    const now = new Date();
    const resolvedBy = chain.arbiter
      ? `chain:upholdSlash:${chain.arbiter.toLowerCase()}`
      : 'chain:upholdSlash';
    const affected = await this.proposals.transitionIfIn(organizationId, proposalId, DISPUTED, {
      status: SlashProposalStatus.UPHELD,
      resolutionKind: ResolutionKind.CHAIN_ARBITER,
      resolvedAt: now,
      countsAsFalsePositive: false,
    });
    if (affected === 0) return this.relabelArbiterUphold(proposal, resolvedBy);
    if (proposal.disputeId) {
      await this.disputes.update(
        { organizationId, id: proposal.disputeId, resolvedAt: IsNull() },
        {
          state: ARBITRATION_STATE_MAP[ArbitrationOutcome.UPHELD],
          outcome: ArbitrationOutcome.UPHELD,
          resolutionKind: ResolutionKind.CHAIN_ARBITER,
          resolvedAt: now,
          resolvedBy,
        },
      );
    }
    return true;
  }

  /**
   * {@link recordChainUphold}'s relabel: `AUTO_UNDISPUTED` → `CHAIN_ARBITER`
   * on a case already upheld (or executing, or executed), compare-and-set on
   * the status read, so a case that moved on meanwhile is not touched. A
   * dispute row the undisputed path closed is relabelled with it.
   */
  private async relabelArbiterUphold(
    proposal: SlashProposalEntity,
    resolvedBy: string,
  ): Promise<boolean> {
    const fresh = await this.lifecycle.require(proposal.organizationId, proposal.id);
    const upheld: readonly string[] = [
      SlashProposalStatus.UPHELD,
      SlashProposalStatus.EXECUTING,
      SlashProposalStatus.EXECUTED,
    ];
    if (fresh.resolutionKind !== ResolutionKind.AUTO_UNDISPUTED || !upheld.includes(fresh.status)) {
      return false;
    }
    const relabelled = await this.proposals.transitionIfIn(
      fresh.organizationId,
      fresh.id,
      [fresh.status],
      { status: fresh.status, resolutionKind: ResolutionKind.CHAIN_ARBITER },
    );
    if (relabelled === 0) return false;
    if (fresh.disputeId) {
      await this.disputes.update(
        {
          organizationId: fresh.organizationId,
          id: fresh.disputeId,
          resolvedBy: 'chain:undisputed',
        },
        {
          outcome: ArbitrationOutcome.UPHELD,
          resolutionKind: ResolutionKind.CHAIN_ARBITER,
          resolvedBy,
        },
      );
    }
    return true;
  }

  /**
   * Review R2-3: the case closed with a record executed and another the
   * provider won on chain (the arbiter's cancel, or a dispute nobody ruled
   * on: `chainDisputeWonAt`). The objection succeeded in part, so its row
   * reads `PARTIALLY_UPHELD` — whichever chain path closed it first (the
   * arbiter's uphold of the other record, or the execution). Its outcome is
   * `UPHELD_RECALCULATED`, the pair `ARBITRATION_STATE_MAP` produces (review
   * R3-6): the judgement stood at a lower figure, the chain's sum of what
   * executed. Nothing acts on a dispute row's outcome, and the case's own
   * `outcome` is not changed. A dispute a person decided (`ADJUDICATOR`) is
   * left alone. Returns whether it changed.
   */
  async recordPartialChainWin(organizationId: string, proposalId: string): Promise<boolean> {
    const proposal = await this.lifecycle.require(organizationId, proposalId);
    if (!proposal.disputeId || !proposal.chainDisputeWonAt) return false;
    const dispute = await this.disputes.findOneBy({ organizationId, id: proposal.disputeId });
    if (!dispute || dispute.state === DisputeResolutionState.PARTIALLY_UPHELD) return false;
    if (dispute.resolvedBy && !dispute.resolvedBy.startsWith('chain:')) return false;
    await this.disputes.update(
      { organizationId, id: dispute.id },
      {
        state: ARBITRATION_STATE_MAP[ArbitrationOutcome.UPHELD_RECALCULATED],
        outcome: ArbitrationOutcome.UPHELD_RECALCULATED,
        resolutionKind: dispute.resolutionKind ?? ResolutionKind.AUTO_CHAIN_EXECUTED,
        resolvedAt: dispute.resolvedAt ?? new Date(),
        resolvedBy: dispute.resolvedBy ?? 'chain:executeSlash',
      },
    );
    return true;
  }

  /**
   * Review R2-2: a dispute sent on chain before a record's door was mirrored
   * only after the platform had labelled the case `UPHELD` /
   * `AUTO_UNDISPUTED` (the watcher's confirmation lag), and now only disputed
   * records stand and nothing executed. The label was wrong: the case goes
   * back to `DISPUTED` and waits for the arbiter, exactly as if the dispute
   * had been seen in time — a dispute row opened (or the one the undisputed
   * path closed, reopened) and `DISPUTE_FILED` on the timeline. Money does not
   * move here: the chain refuses to execute a disputed record.
   *
   * Only `UPHELD` (or the executor's `EXECUTING`, review R3-5) with
   * `AUTO_UNDISPUTED` and no execution, and the write is a compare-and-set on
   * that label; an arbiter's uphold (`CHAIN_ARBITER`) is never undone. Returns
   * whether the case moved.
   */
  async reopenForChainDispute(
    organizationId: string,
    proposalId: string,
    chain: { readonly requestId: string; readonly transactionHash: string | null },
  ): Promise<boolean> {
    const proposal = await this.lifecycle.require(organizationId, proposalId);
    if (
      !REOPENABLE_STATUSES.includes(proposal.status as SlashProposalStatus) ||
      proposal.resolutionKind !== ResolutionKind.AUTO_UNDISPUTED ||
      proposal.executedAt
    ) {
      return false;
    }
    const reason =
      `Disputed on chain: the provider called disputeSlash on record ${chain.requestId}` +
      `${chain.transactionHash ? ` (transaction ${chain.transactionHash})` : ''}; the dispute ` +
      'was seen after the case had been marked undisputed.';
    if (!proposal.disputeId) {
      try {
        await this.openDispute(
          organizationId,
          proposalId,
          {
            reason,
            openedBy: 'chain:disputeSlash',
          },
          chain,
          { reopen: true },
        );
        return true;
      } catch (error) {
        if ((error as { errorCode?: string })?.errorCode?.startsWith('SLASH_')) return false;
        throw error;
      }
    }
    // A dispute row `recordChainStanding` closed.
    const now = new Date();
    const affected = await this.proposals.transitionIfInResolvedAs(
      organizationId,
      proposalId,
      REOPENABLE_STATUSES,
      ResolutionKind.AUTO_UNDISPUTED,
      {
        status: SlashProposalStatus.DISPUTED,
        resolutionKind: null,
        resolvedAt: null,
        chainClaimedAt: null,
      },
    );
    if (affected === 0) return false;
    await this.disputes.update(
      { organizationId, id: proposal.disputeId, resolvedBy: 'chain:undisputed' },
      { state: 'OPEN', outcome: null, resolutionKind: null, resolvedAt: null, resolvedBy: null },
    );
    await this.lifecycle.appendEventDirect({
      organizationId,
      proposalId,
      occurredAt: now,
      kind: 'DISPUTE_FILED',
      actorType: 'provider',
      actorId: 'chain:disputeSlash',
      summary: 'Disputed on chain (disputeSlash); the arbiter rules on chain',
      detail: { disputeId: proposal.disputeId, onChain: true, requestId: chain.requestId },
    });
    return true;
  }

  /**
   * Review N-1 / N-3: a `DISPUTED` case one of whose records stands on chain
   * undisputed (a sibling of the disputed record, or a straggler re-adopted).
   * The chain decides that record, and it executes after its `executableAt`,
   * so the case becomes `UPHELD` (`AUTO_UNDISPUTED`, no outcome: nobody ruled)
   * and the executor sends it. Returns whether the case moved.
   *
   * Review R4-1: while another record of the case still stands disputed, its
   * dispute row stays open — the arbiter has not ruled on that record, and the
   * row closes when it does (uphold, cancel or expiry).
   */
  async recordChainStanding(
    organizationId: string,
    proposalId: string,
    options: { readonly disputeStillOpen?: boolean } = {},
  ): Promise<boolean> {
    const proposal = await this.lifecycle.require(organizationId, proposalId);
    const now = new Date();
    const affected = await this.proposals.transitionIfIn(organizationId, proposalId, DISPUTED, {
      status: SlashProposalStatus.UPHELD,
      resolutionKind: ResolutionKind.AUTO_UNDISPUTED,
      resolvedAt: now,
      countsAsFalsePositive: false,
    });
    if (affected === 0) return false;
    if (proposal.disputeId && !options.disputeStillOpen) {
      await this.disputes.update(
        { organizationId, id: proposal.disputeId, resolvedAt: IsNull() },
        {
          state: ARBITRATION_STATE_MAP[ArbitrationOutcome.UPHELD],
          resolvedAt: now,
          resolvedBy: 'chain:undisputed',
        },
      );
    }
    await this.lifecycle.appendEventDirect({
      organizationId,
      proposalId,
      occurredAt: now,
      kind: 'AUTO_CLOSED',
      actorType: 'system',
      actorId: null,
      summary:
        'A record of this case stands on chain undisputed, so it executes after its ' +
        'executableAt; only a dispute sent on chain (disputeSlash) could have frozen it',
      detail: { from: proposal.status },
    });
    return true;
  }

  private async openDispute(
    organizationId: string,
    proposalId: string,
    input: { reason: string; openedBy: string },
    chain: { readonly requestId: string; readonly transactionHash: string | null },
    // Review R2-2: an EVM case wrongly labelled undisputed (`UPHELD`) is the
    // only other status a dispute opens from; its resolution is cleared.
    options: { readonly reopen?: boolean } = {},
  ): Promise<{ proposal: SlashProposalEntity; dispute: DisputeEntity }> {
    const proposal = await this.lifecycle.require(organizationId, proposalId);
    const from: readonly SlashProposalStatus[] = options.reopen
      ? REOPENABLE_STATUSES
      : [SlashProposalStatus.PROPOSED];

    if (proposal.disputeId) {
      throw SlashErrors.alreadyDisputed({ disputeId: proposal.disputeId });
    }
    if (
      !from.includes(proposal.status as SlashProposalStatus) ||
      (options.reopen && proposal.resolutionKind !== ResolutionKind.AUTO_UNDISPUTED)
    ) {
      throw SlashErrors.notDisputable({ status: proposal.status });
    }

    const now = new Date();
    const dispute = new DisputeEntity();
    dispute.organizationId = organizationId;
    dispute.subjectType = 'SLASH_PROPOSAL';
    dispute.subjectId = proposal.id;
    dispute.providerId = proposal.providerId;
    dispute.state = 'OPEN';
    dispute.claimType = DisputeClaimType.OTHER;
    dispute.reason = input.reason;
    dispute.evidence = [];
    dispute.openedBy = input.openedBy;
    // No platform deadline: the arbiter is the only judge, and an unruled
    // dispute expires on chain after 30 days.
    dispute.acknowledgedAt = now;
    dispute.deadlineAt = null;
    dispute.platformDueAt = null;
    dispute.reasonCodes = [];

    const savedDispute = await this.disputes.save(dispute);

    const patch = {
      status: SlashProposalStatus.DISPUTED,
      disputedAt: now,
      disputeId: savedDispute.id,
      ...(options.reopen ? { resolutionKind: null, resolvedAt: null, chainClaimedAt: null } : {}),
    };
    // Review R3-5: a reopen is a compare-and-set on the label it read, so a
    // concurrent relabel to `CHAIN_ARBITER` is never undone.
    const affected = options.reopen
      ? await this.proposals.transitionIfInResolvedAs(
          organizationId,
          proposal.id,
          from,
          ResolutionKind.AUTO_UNDISPUTED,
          patch,
        )
      : await this.proposals.transitionIfIn(organizationId, proposal.id, from, patch);
    if (affected === 0) {
      // Lost a race with the undisputed sweeper. The dispute row stays — it is
      // evidence that the provider did answer, and deleting it would leave the
      // case looking unanswered forever.
      throw SlashErrors.notDisputable({ status: 'auto-closed while filing' });
    }

    await this.lifecycle.appendEventDirect({
      organizationId,
      proposalId: proposal.id,
      occurredAt: now,
      kind: 'DISPUTE_FILED',
      actorType: 'provider',
      actorId: input.openedBy,
      summary: 'Disputed on chain (disputeSlash); the arbiter rules on chain',
      detail: {
        disputeId: savedDispute.id,
        claimType: DisputeClaimType.OTHER,
        onChain: true,
        requestId: chain.requestId,
      },
    });

    return {
      proposal: await this.lifecycle.require(organizationId, proposal.id),
      dispute: savedDispute,
    };
  }
}
