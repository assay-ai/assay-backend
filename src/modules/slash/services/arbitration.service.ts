import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { QueryRunner } from 'typeorm';

import { DisputeEntity } from '@database/postgres/entities/dispute.entity';
import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { DisputeRepository } from '@database/postgres/repositories/dispute.repository';
import { SlaStrikeEntity } from '@database/postgres/entities/sla-strike.entity';
import { SlaStrikeRepository } from '@database/postgres/repositories/sla-strike.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
} from '@modules/notification/ports/notification.port';
import { OverrideLogService } from '@modules/operator/services/override-log.service';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';

import { SLASH_CONFIG, SlashConfig } from '../constants/slash.constants';
import { ChainProposalStatus } from '../domain/chain-slash-outcome';
import {
  ARBITRATION_STATE_MAP,
  ArbitrationOutcome,
  CURRENT_RUBRIC_VERSION,
  DisputeClaimType,
  isOverturn,
  OUTCOME_CONSEQUENCE,
  reasonCodesAreValid,
  ResolutionKind,
} from '../domain/arbitration';
import {
  canTransition,
  requiresSecondSignature,
  SlashProposalStatus,
  statusForOutcome,
} from '../domain/slash-proposal-state';
import { SlashErrors } from '../errors/slash.errors';
import { SlashExecutionService } from './slash-execution.service';
import { SlashProposalService } from './slash-proposal.service';

export interface DecideInput {
  readonly outcome: ArbitrationOutcome;
  readonly reasonCodes: readonly string[];
  readonly note: string;
  readonly rootCauseKey?: string | null;
  readonly ticketRef?: string | null;
  readonly recalculatedAmount?: string | null;
}

/**
 * The human half.
 *
 * Everything here happens because an operator clicked something, and every
 * method here therefore goes through `OverrideLogService.perform` — which is
 * not a convention this class follows but a property it cannot escape: the
 * mutation and the register entry share one transaction, so there is no
 * ordering in which the change lands and the record does not.
 *
 * ## Where the polarity flip is handled
 *
 * `disputes.state` describes what happened to the **objection**;
 * `slash_proposals.outcome` describes what happened to the **proposal**. They
 * point in opposite directions. `ARBITRATION_STATE_MAP` is the only place the
 * translation happens, and `finalise` is the only caller. Getting it backwards
 * would tell a provider they won a case they lost, in the notification, in
 * writing, with money attached.
 *
 * ## Why a decision does not execute anything
 *
 * `decide` moves the case to `UPHELD` and stops. Execution is a separate,
 * later, scheduled step gated on `earliestExecutionAt`, because the case
 * screen promises the provider that *nothing executes before that deadline, even if
 * you do nothing* — and a decide-then-execute path would make that promise
 * depend on an adjudicator not working quickly. The timelock is not a queue
 * delay; it is the thing that makes the appeal real.
 */
@Injectable()
export class ArbitrationService {
  private readonly logger = new Logger(ArbitrationService.name);

  constructor(
    private readonly proposals: SlashProposalRepository,
    private readonly disputes: DisputeRepository,
    private readonly strikes: SlaStrikeRepository,
    private readonly lifecycle: SlashProposalService,
    private readonly overrides: OverrideLogService,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    @Inject(SLASH_CONFIG) private readonly config: SlashConfig,
    // `@Optional()` for the same structural reason `SlashExecutionService`
    // marks its own executor optional: a composition without `ChainsModule` has
    // nothing for it to call, and a decision must still be recordable there.
    // `SlashModule` provides both services, and the dependency runs one way —
    // execution knows nothing about arbitration — so this is a constructor
    // injection and no module edit.
    @Optional() private readonly execution: SlashExecutionService | null = null,
  ) {}

  // ── The provider's side ───────────────────────────────────────────────────

  /**
   * File an objection. Starts **our** clock.
   *
   * No override entry: this is the provider exercising a right, not an operator
   * intervening. Putting it in the register would dilute a list whose value is
   * that every row is something a human on our side chose to do.
   */
  async fileDispute(
    organizationId: string,
    proposalId: string,
    input: {
      claimType: DisputeClaimType;
      reason: string;
      evidence: unknown[];
      openedBy: string;
    },
  ): Promise<{ proposal: SlashProposalEntity; dispute: DisputeEntity }> {
    const proposal = await this.lifecycle.require(organizationId, proposalId);

    if (proposal.disputeId) {
      throw SlashErrors.alreadyDisputed({ disputeId: proposal.disputeId });
    }
    if (proposal.status !== SlashProposalStatus.PROPOSED) {
      throw SlashErrors.notDisputable({ status: proposal.status });
    }
    // Checked separately from the state so the provider is told *why*. "Wrong
    // state" when the truth is "you were three hours late" produces a support
    // ticket instead of an understanding.
    const now = new Date();
    if (proposal.respondByAt && proposal.respondByAt.getTime() < now.getTime()) {
      throw SlashErrors.responseWindowClosed({
        respondByAt: proposal.respondByAt.toISOString(),
      });
    }

    const platformDueAt = new Date(now.getTime() + this.config.platformDecisionWindowMs);

    const dispute = new DisputeEntity();
    dispute.organizationId = organizationId;
    dispute.subjectType = 'SLASH_PROPOSAL';
    dispute.subjectId = proposal.id;
    // The column used to be hardcoded to null. A provider's objection has a
    // provider on it, and `?providerId=` filtering was dead until it did.
    dispute.providerId = proposal.providerId;
    dispute.state = 'OPEN';
    dispute.claimType = input.claimType;
    dispute.reason = input.reason;
    dispute.evidence = input.evidence;
    dispute.openedBy = input.openedBy;
    // Acknowledged at filing: the provider is the one who filed, so there is no
    // third party whose receipt we are waiting on. `chk_disputes_deadline_needs_ack`
    // requires the pair, and leaving both null would put a case in the queue
    // with no deadline at all.
    dispute.acknowledgedAt = now;
    dispute.deadlineAt = proposal.respondByAt;
    dispute.platformDueAt = platformDueAt;
    dispute.reasonCodes = [];

    const savedDispute = await this.disputes.save(dispute);

    const affected = await this.proposals.transitionIfIn(
      organizationId,
      proposal.id,
      [SlashProposalStatus.PROPOSED],
      {
        status: SlashProposalStatus.DISPUTED,
        disputedAt: now,
        disputeId: savedDispute.id,
        platformDecisionDueAt: platformDueAt,
      },
    );
    if (affected === 0) {
      // Lost a race with the undisputed sweeper. The dispute row stays — it is
      // evidence that the provider did answer, and deleting it would leave the
      // case looking unanswered forever. The refusal names the state so the
      // provider can tell which happened.
      throw SlashErrors.notDisputable({ status: 'auto-closed while filing' });
    }

    await this.lifecycle.appendEventDirect({
      organizationId,
      proposalId: proposal.id,
      occurredAt: now,
      kind: 'DISPUTE_FILED',
      actorType: 'provider',
      actorId: input.openedBy,
      summary: `Objection filed: ${input.claimType}`,
      detail: {
        disputeId: savedDispute.id,
        claimType: input.claimType,
        platformDueAt: platformDueAt.toISOString(),
      },
    });

    return {
      proposal: await this.lifecycle.require(organizationId, proposal.id),
      dispute: savedDispute,
    };
  }

  // ── The operator's side ───────────────────────────────────────────────────

  /**
   * Take ownership of a case.
   *
   * The only mutating operator route with no register row, and it is exempt by
   * a named decorator rather than by omission. It moves no money and changes
   * nobody's state but the queue's — but the adjudication queue renders an
   * unowned case in red precisely because ownership is the thing that decides
   * whether it gets worked, so the timeline records it.
   */
  async claim(
    operator: OperatorSession,
    organizationId: string,
    proposalId: string,
  ): Promise<SlashProposalEntity> {
    const proposal = await this.lifecycle.require(organizationId, proposalId);
    const now = new Date();

    if (proposal.status === SlashProposalStatus.DISPUTED) {
      const affected = await this.proposals.transitionIfIn(
        organizationId,
        proposalId,
        [SlashProposalStatus.DISPUTED],
        { status: SlashProposalStatus.UNDER_REVIEW },
      );
      if (affected === 0) {
        throw SlashErrors.invalidTransition({
          from: proposal.status,
          to: SlashProposalStatus.UNDER_REVIEW,
        });
      }
    }

    if (proposal.disputeId) {
      await this.disputes.update(
        { organizationId, id: proposal.disputeId },
        {
          state: 'UNDER_REVIEW',
          assignedOperatorId: operator.operatorId,
          assignedAt: now,
        },
      );
    }

    await this.lifecycle.appendEventDirect({
      organizationId,
      proposalId,
      occurredAt: now,
      kind: 'ASSIGNED',
      actorType: 'operator',
      actorId: operator.subject,
      summary: `Assigned to ${operator.subject}`,
      detail: { operatorId: operator.operatorId },
    });

    return this.lifecycle.require(organizationId, proposalId);
  }

  /**
   * `S-3` — decide a case.
   *
   * Four refusals before anything is written, in the order that costs least:
   * the state, the reason codes, the recalculated amount, and then the register
   * check inside `OverrideLogService`.
   *
   * The note length is validated twice — by `class-validator` on the DTO and by
   * `chk_override_log_entries_decision_reason_length` at the database. Neither
   * is redundant: the first gives a usable error, and the second survives a
   * second write path that somebody adds later.
   */
  async decide(
    operator: OperatorSession,
    organizationId: string,
    proposalId: string,
    input: DecideInput,
    requestId?: string | null,
  ): Promise<SlashProposalEntity> {
    const proposal = await this.lifecycle.require(organizationId, proposalId);

    const from = proposal.status as SlashProposalStatus;
    if (from !== SlashProposalStatus.DISPUTED && from !== SlashProposalStatus.UNDER_REVIEW) {
      throw SlashErrors.invalidTransition({ from, to: 'a decision' });
    }

    if (!reasonCodesAreValid(input.outcome, input.reasonCodes)) {
      throw SlashErrors.invalidReasonCode({
        outcome: input.outcome,
        code: input.reasonCodes.join(','),
      });
    }

    const consequence = OUTCOME_CONSEQUENCE[input.outcome];
    const penalty = this.resolvePenalty(proposal, input);

    const needsSecond = requiresSecondSignature(
      input.outcome,
      BigInt(penalty),
      BigInt(this.config.secondSignatureThresholdMinor),
      consequence.opensFleetSweep,
    );

    const nextStatus = needsSecond
      ? SlashProposalStatus.AWAITING_SECOND
      : statusForOutcome(input.outcome);

    if (!canTransition(from, nextStatus)) {
      throw SlashErrors.invalidTransition({ from, to: nextStatus });
    }

    const now = new Date();

    return this.overrides
      .perform<SlashProposalEntity>(
        {
          code: 'S-3',
          actor: operator,
          targetType: 'slash_proposal',
          targetId: proposalId,
          organizationId,
          reasonCode: input.reasonCodes[0],
          reason: input.note,
          ticketRef: input.ticketRef ?? null,
          requestId: requestId ?? null,
          // The register floor for `S-3` is SINGLE; this occurrence is raised on
          // blast radius or materiality. The register cannot express that,
          // because it is a property of the case rather than of the action.
          escalateToTwoPerson: false,
          amountMinor: penalty,
        },
        async (queryRunner) => {
          const before = {
            status: proposal.status,
            outcome: proposal.outcome,
            penaltyAmount: proposal.penaltyAmount,
          };

          /*
            `outcome`, `resolutionKind` and `resolvedAt` move together or not at
            all, and on this branch they may not move at all.

            Two CHECK constraints bracket them and there is no way between:
            `chk_slash_proposals_resolution_is_whole` demands
            `(resolved_at IS NULL) = (resolution_kind IS NULL)`, and
            `chk_slash_proposals_outcome_needs_adjudicator` demands
            `(resolution_kind = 'ADJUDICATOR') = (outcome IS NOT NULL)`. So the
            three are all-set or all-null, and `AWAITING_SECOND` — a decision
            reached but not yet binding — has no representation among them.

            The pending outcome therefore lives on the DISPUTE row, which
            `writeDisputeDecision` below already writes correctly and whose own
            constraints permit it. `second()` reads it back from there. Writing
            `resolutionKind` here unconditionally is what made every
            second-signature decision fail with a constraint violation.

            `countsAsFalsePositive` is held back for a different reason: it
            feeds the false-positive error metric, and a decision nobody has countersigned
            has not yet cost us anything.
          */
          const binds = !needsSecond;

          const patch: Partial<SlashProposalEntity> & { status: string } = {
            status: nextStatus,
            decidedByOperatorId: operator.operatorId,
            penaltyAmount: penalty,
            rootCauseKey: input.rootCauseKey ?? proposal.rootCauseKey,
            outcome: binds ? input.outcome : null,
            resolutionKind: binds ? ResolutionKind.ADJUDICATOR : null,
            resolvedAt: binds ? now : null,
            countsAsFalsePositive: binds ? consequence.countsAsFalsePositive : false,
          };

          const affected = await this.updateInTransaction(
            queryRunner,
            organizationId,
            proposalId,
            [from],
            patch,
          );
          if (affected === 0) {
            throw SlashErrors.invalidTransition({ from, to: nextStatus });
          }

          await this.writeDisputeDecision(queryRunner, proposal, input, operator, needsSecond, now);

          if (!needsSecond) {
            await this.applyConsequences(queryRunner, proposal, input.outcome);
          }

          await this.lifecycle.appendEvent(queryRunner, {
            organizationId,
            proposalId,
            occurredAt: now,
            kind: 'DECIDED',
            actorType: 'operator',
            actorId: operator.subject,
            summary: needsSecond
              ? `${operator.subject} decided ${input.outcome}; a second signature is required`
              : `${operator.subject} decided ${input.outcome}`,
            detail: {
              outcome: input.outcome,
              reasonCodes: input.reasonCodes,
              rubricVersion: CURRENT_RUBRIC_VERSION,
              requiresSecondSignature: needsSecond,
            },
          });

          const after = { status: nextStatus, outcome: input.outcome, penaltyAmount: penalty };
          const value = await queryRunner.manager.findOneOrFail(SlashProposalEntity, {
            where: { organizationId, id: proposalId },
          });
          return { value, before, after };
        },
      )
      .then(async (saved) => {
        if (!needsSecond) await this.notifyDecision(saved, input.outcome);
        await this.settleTheChainProposal(organizationId, proposalId, saved.status, input.outcome);
        return saved;
      });
  }

  /**
   * The second reader signs, or objects.
   *
   * An objection sends the case back to `UNDER_REVIEW`, undecided. It does not
   * overturn the first decision and it does not resolve the case some other
   * way: the rule is that disagreement escalates to an independent third
   * reader, not to a negotiation between the first two, and returning the case
   * to the queue is the honest MVP of that. An objection that silently became a
   * veto would let the second reader decide every case they disagreed with,
   * without ever writing a decision of their own.
   *
   * The objection's reason is mandatory — *"an objection must also record a reason"* —
   * and is written to the dispute rather than discarded, because the third
   * reader needs to know what the second one saw.
   */
  async second(
    operator: OperatorSession,
    organizationId: string,
    proposalId: string,
    kind: 'SIGNED' | 'OBJECTED',
    note: string,
    requestId?: string | null,
  ): Promise<SlashProposalEntity> {
    const proposal = await this.lifecycle.require(organizationId, proposalId);

    if (proposal.status !== SlashProposalStatus.AWAITING_SECOND) {
      throw SlashErrors.secondSignatureNotPending({ status: proposal.status });
    }
    if (proposal.decidedByOperatorId === operator.operatorId) {
      throw SlashErrors.secondSignatureRequired();
    }

    /*
      The pending outcome is read from the DISPUTE, not the proposal.

      `decide` cannot leave it on `slash_proposals` while the case is
      `AWAITING_SECOND`: the outcome/resolutionKind/resolvedAt triple is
      all-or-nothing there under two CHECK constraints, and a decision awaiting
      a countersignature has resolved nothing. The dispute row carries it in the
      meantime — see the note in `decide`.
    */
    const dispute = proposal.disputeId
      ? await this.disputes.findOneBy({ organizationId, id: proposal.disputeId })
      : null;
    const outcome = dispute?.outcome as ArbitrationOutcome | undefined;
    if (!outcome) {
      // Unreachable by the state machine — `AWAITING_SECOND` is only reachable
      // through `decide`, which always writes the dispute. Loud rather than
      // silent, because a countersignature on an unknown outcome would resolve
      // the case to whatever `statusForOutcome(undefined)` happened to return.
      throw SlashErrors.secondSignatureNotPending({ status: proposal.status });
    }

    const now = new Date();
    const nextStatus =
      kind === 'SIGNED' ? statusForOutcome(outcome) : SlashProposalStatus.UNDER_REVIEW;

    return this.overrides
      .perform<SlashProposalEntity>(
        {
          // `S-12`, not `S-3`. The countersignature is a distinct act by a
          // distinct person; filing it under the decision's own code would make
          // the register read as though one case had been decided twice.
          code: 'S-12',
          actor: operator,
          targetType: 'slash_proposal',
          targetId: proposalId,
          organizationId,
          reasonCode: kind === 'SIGNED' ? 'SECOND_SIGNED' : 'SECOND_OBJECTED',
          reason: note,
          requestId: requestId ?? null,
          amountMinor: proposal.penaltyAmount,
        },
        async (queryRunner) => {
          const before = { status: proposal.status, secondKind: proposal.secondKind };

          const patch: Partial<SlashProposalEntity> & { status: string } =
            kind === 'SIGNED'
              ? {
                  status: nextStatus,
                  secondedByOperatorId: operator.operatorId,
                  secondedAt: now,
                  secondKind: 'SIGNED',
                  // The decision binds HERE, so this is where the three
                  // constrained columns are written — together, which is the
                  // only way the CHECKs allow. `decide` deliberately left them
                  // null; see its note.
                  outcome,
                  resolutionKind: ResolutionKind.ADJUDICATOR,
                  resolvedAt: now,
                  countsAsFalsePositive: OUTCOME_CONSEQUENCE[outcome].countsAsFalsePositive,
                }
              : {
                  status: nextStatus,
                  // The objection is recorded and then the decision is cleared,
                  // because the case is genuinely undecided again. Leaving the
                  // outcome behind would let a later reader mistake a rejected
                  // decision for a standing one.
                  secondedByOperatorId: operator.operatorId,
                  secondedAt: now,
                  secondKind: 'OBJECTED',
                  outcome: null,
                  resolutionKind: null,
                  decidedByOperatorId: null,
                  resolvedAt: null,
                  countsAsFalsePositive: false,
                };

          const affected = await this.updateInTransaction(
            queryRunner,
            organizationId,
            proposalId,
            [SlashProposalStatus.AWAITING_SECOND],
            patch,
          );
          if (affected === 0) {
            throw SlashErrors.secondSignatureNotPending({ status: proposal.status });
          }

          if (proposal.disputeId) {
            await queryRunner.manager.update(
              DisputeEntity,
              { organizationId, id: proposal.disputeId },
              kind === 'SIGNED'
                ? {
                    secondedByOperatorId: operator.operatorId,
                    secondedAt: now,
                    secondKind: 'SIGNED',
                    secondNote: note,
                    state: ARBITRATION_STATE_MAP[outcome],
                    resolvedAt: now,
                    resolvedBy: operator.subject,
                    resolutionKind: ResolutionKind.ADJUDICATOR,
                  }
                : {
                    secondedByOperatorId: operator.operatorId,
                    secondedAt: now,
                    secondKind: 'OBJECTED',
                    secondNote: note,
                    state: 'UNDER_REVIEW',
                    outcome: null,
                    resolutionKind: null,
                  },
            );
          }

          if (kind === 'SIGNED') {
            await this.applyConsequences(queryRunner, proposal, outcome);
          }

          await this.lifecycle.appendEvent(queryRunner, {
            organizationId,
            proposalId,
            occurredAt: now,
            kind: kind === 'SIGNED' ? 'SECONDED' : 'SECOND_OBJECTED',
            actorType: 'operator',
            actorId: operator.subject,
            summary:
              kind === 'SIGNED'
                ? `${operator.subject} countersigned ${outcome}`
                : `${operator.subject} objected; the case returns to review undecided`,
            detail: { note, outcome },
          });

          const value = await queryRunner.manager.findOneOrFail(SlashProposalEntity, {
            where: { organizationId, id: proposalId },
          });
          return { value, before, after: { status: nextStatus, secondKind: kind } };
        },
      )
      .then(async (saved) => {
        // `outcome` is a local here, read back off the DISPUTE row — `second()`
        // has no `input.outcome`, because `decide()` deliberately left the
        // proposal's outcome null while the case awaited a countersignature.
        if (kind === 'SIGNED') {
          await this.notifyDecision(saved, outcome);
          await this.settleTheChainProposal(organizationId, proposalId, saved.status, outcome);
        }
        return saved;
      });
  }

  /**
   * `S-1` — suspend a proposal before anything is signed.
   *
   * Terminal. There is no un-suspend, because the finding is still on record as
   * a strike and a re-proposal would restart the provider's clock — which is
   * the correct thing to happen if we want to levy it after all, and is not the
   * same object.
   *
   * **`EXECUTING` is refused, deliberately.** The state machine has an
   * `EXECUTING → CANCELLED` edge, and that edge exists for one caller: the
   * chain-void path, which reaches it only after the settlement program has
   * refused the judgement permanently. `S-1` is the opposite situation — the
   * chain has accepted it, a `SlashRecord` is `Pending`, and the transaction may
   * be in flight this second. Closing the case here would leave that record
   * standing with the provider's stake reserved until `expire_slash` reaps it
   * seven days later, and would let an operator record a suspension of an
   * execution that then lands anyway. Allowing it needs an on-chain
   * `cancel_slash` first, which is a design decision nobody has taken.
   */
  async suspend(
    operator: OperatorSession,
    organizationId: string,
    proposalId: string,
    reasonCode: string,
    note: string,
    ticketRef?: string | null,
    requestId?: string | null,
  ): Promise<SlashProposalEntity> {
    const proposal = await this.lifecycle.require(organizationId, proposalId);
    const from = proposal.status as SlashProposalStatus;

    // See the header: the `EXECUTING → CANCELLED` edge belongs to the
    // chain-void path, not to `S-1`. Refused here rather than by the state
    // machine, because the edge itself is legal and one caller needs it.
    if (
      from === SlashProposalStatus.EXECUTING ||
      !canTransition(from, SlashProposalStatus.CANCELLED)
    ) {
      throw SlashErrors.invalidTransition({ from, to: SlashProposalStatus.CANCELLED });
    }

    const now = new Date();
    return this.overrides.perform<SlashProposalEntity>(
      {
        code: 'S-1',
        actor: operator,
        targetType: 'slash_proposal',
        targetId: proposalId,
        organizationId,
        reasonCode,
        reason: note,
        ticketRef: ticketRef ?? null,
        requestId: requestId ?? null,
        amountMinor: proposal.penaltyAmount,
      },
      async (queryRunner) => {
        const affected = await this.updateInTransaction(
          queryRunner,
          organizationId,
          proposalId,
          [from],
          {
            status: SlashProposalStatus.CANCELLED,
            resolutionKind: ResolutionKind.ADJUDICATOR,
            resolvedAt: now,
            outcome: null,
            decidedByOperatorId: operator.operatorId,
          },
        );
        if (affected === 0) {
          throw SlashErrors.invalidTransition({ from, to: SlashProposalStatus.CANCELLED });
        }

        await this.lifecycle.appendEvent(queryRunner, {
          organizationId,
          proposalId,
          occurredAt: now,
          kind: 'CANCELLED',
          actorType: 'operator',
          actorId: operator.subject,
          summary: `Suspended by ${operator.subject}: ${reasonCode}`,
          detail: { reasonCode, note },
        });

        const value = await queryRunner.manager.findOneOrFail(SlashProposalEntity, {
          where: { organizationId, id: proposalId },
        });
        return {
          value,
          before: { status: from },
          after: { status: SlashProposalStatus.CANCELLED },
        };
      },
    );
  }

  /**
   * `S-8` — give the provider more time to object.
   *
   * Moves `respondByAt` and the dispute's `deadlineAt` together, and refuses on
   * a case that has already left `PROPOSED`: extending a window that has closed
   * is not an extension, it is a re-opening, and re-opening a decided case has
   * to be a decision rather than a date change.
   *
   * **Known incomplete, and named rather than hidden.** The `S-8` register row
   * requires that extending a deadline *also* extends body retention for that
   * window. `evidence_bodies` are scrubbed at 72 hours on their own schedule
   * with no per-window hold, so an extension past that point leaves the adjudicator
   * deciding on hashes — an evidence-freshness gap, left as open work rather
   * than half-built.
   *
   * ## The extension the chain will not honour
   *
   * `PROPOSED` is not "before the chain hears about this". The propose sweep
   * selects on `respond_by_at IS NOT NULL`
   * (`SlashProposalRepository.findAwaitingChainProposal`), so a `PROPOSED` case
   * routinely already has a `SlashRecord` standing on chain — and that record's
   * `executable_at` was frozen at `chain_proposed_at + slash_delay_seconds`
   * when it was written. Nothing here re-proposes it, so nothing here moves it.
   *
   * `execute_slash` is **permissionless**: its only signer is `payer`, and the
   * handler consults it about nothing. Once that frozen moment passes, any
   * stranger may take the penalty. So an extension that pushes
   * `earliestExecutionAt` past `chain_executable_at` does not extend anything —
   * it converts the case screen's promise into a claim this platform cannot
   * keep, and neither the boot assertion in `slash.constants.ts` nor `executeOne`'s
   * `max(both clocks)` predicate can stop it, because both constrain this
   * backend rather than the world.
   *
   * Such an extension is **refused**, not clamped. Silently granting three days
   * where five were asked for leaves the operator believing the longer promise
   * and repeating it to the provider. Suspending the case (`S-1`) and
   * re-proposing restarts the on-chain clock and is the way to actually buy the
   * time.
   *
   * ## The three states, and what each of them is checked against
   *
   * - `PENDING` — the deadline is known. Refused when the extension runs past
   *   it ({@link SlashErrors.extensionExceedsChainTimelock}).
   * - `PROPOSING` — the deadline is **unknown**, and this is not a millisecond
   *   of transit: `proposeDue` deliberately leaves a row claimed and
   *   `PROPOSING` on any failure the program did not name, because the
   *   transaction may already have landed. The stale sweep reaps the claim after
   *   `CHAIN_CLAIM_STALE_MS` (ten minutes), and an RPC outage holds it there for
   *   as long as the outage lasts — with a real door possibly already open and
   *   the column still null. Refused outright
   *   ({@link SlashErrors.extensionWhileProposing}); retrying in a minute costs
   *   the operator far less than the promise being wrong.
   * - `NONE` — no record and no door, so an extension of any length is granted
   *   here. What keeps *that* honest is at the other end:
   *   `SlashExecutionService.proposeDue` will not propose a case whose promise
   *   outruns the earliest door a fresh record could have
   *   (`now + MIN_SLASH_DELAY_MS`), so the record is written later rather than
   *   the promise being broken. Extending on `NONE` and then proposing blindly
   *   was the larger half of this same defect.
   *
   * `CANCELLED`, `REFUSED` and `EXECUTED` have no live record to be executed
   * out from under the provider, so none of them is checked.
   *
   * The refusal is evaluated twice on purpose — once here against the row that
   * was read, and once inside the write's own `WHERE` clause. A propose landing
   * between the two would otherwise slip through a check that had already
   * passed; see {@link extensionRefusal}.
   */
  async extendDeadline(
    operator: OperatorSession,
    organizationId: string,
    proposalId: string,
    additionalHours: number,
    reasonCode: string,
    note: string,
    requestId?: string | null,
  ): Promise<SlashProposalEntity> {
    const proposal = await this.lifecycle.require(organizationId, proposalId);

    if (proposal.status !== SlashProposalStatus.PROPOSED || !proposal.respondByAt) {
      throw SlashErrors.notDisputable({ status: proposal.status });
    }

    const extendedTo = new Date(proposal.respondByAt.getTime() + additionalHours * 60 * 60 * 1000);
    // The timelock moves with it. Leaving `earliestExecutionAt` where it was
    // would create a window in which the provider may still object and the
    // penalty may already have executed — which is the one thing the case
    // screen promises cannot happen.
    const executionAt =
      extendedTo.getTime() > proposal.earliestExecutionAt.getTime()
        ? extendedTo
        : proposal.earliestExecutionAt;

    // The chain's door is already open at a fixed hour and cannot be moved from
    // here. See this method's header — refusing is the only honest answer.
    const refusal = this.extensionRefusal(proposal, executionAt);
    if (refusal) throw refusal;

    const now = new Date();

    return this.overrides.perform<SlashProposalEntity>(
      {
        code: 'S-8',
        actor: operator,
        targetType: 'slash_proposal',
        targetId: proposalId,
        organizationId,
        reasonCode,
        reason: note,
        requestId: requestId ?? null,
      },
      async (queryRunner) => {
        // `chain_status` and `chain_executable_at` are in the WHERE clause, not
        // only in the guard above. The guard read the row before this
        // transaction opened, and `proposeDue` runs every minute: a propose
        // landing in that interval would otherwise be extended past a door that
        // did not exist when it was checked. A check that is not in the write's
        // own predicate is not a check — the same lesson the propose claim
        // learned earlier in this branch.
        const affected = await this.updateInTransaction(
          queryRunner,
          organizationId,
          proposalId,
          [SlashProposalStatus.PROPOSED],
          {
            status: SlashProposalStatus.PROPOSED,
            respondByAt: extendedTo,
            earliestExecutionAt: executionAt,
          },
          executionAt,
        );
        if (affected === 0) {
          // Re-read rather than assume. Losing this CAS has three causes with
          // three different remedies — the case moved on, a propose landed, or
          // one is in flight — and telling an operator "not disputable" when the
          // truth is "retry in a minute" is how a support ticket gets opened
          // about a system that was working.
          const current = await queryRunner.manager.findOneOrFail(SlashProposalEntity, {
            where: { organizationId, id: proposalId },
          });
          throw (
            this.extensionRefusal(current, executionAt) ??
            SlashErrors.notDisputable({ status: current.status })
          );
        }

        if (proposal.disputeId) {
          await queryRunner.manager.update(
            DisputeEntity,
            { organizationId, id: proposal.disputeId },
            { deadlineAt: extendedTo },
          );
        }

        await this.lifecycle.appendEvent(queryRunner, {
          organizationId,
          proposalId,
          occurredAt: now,
          kind: 'DEADLINE_EXTENDED',
          actorType: 'operator',
          actorId: operator.subject,
          summary: `Deadline extended to ${extendedTo.toISOString()} by ${operator.subject}`,
          detail: { additionalHours, reasonCode },
        });

        const value = await queryRunner.manager.findOneOrFail(SlashProposalEntity, {
          where: { organizationId, id: proposalId },
        });
        return {
          value,
          before: {
            respondByAt: proposal.respondByAt.toISOString(),
            earliestExecutionAt: proposal.earliestExecutionAt.toISOString(),
          },
          after: {
            respondByAt: extendedTo.toISOString(),
            earliestExecutionAt: executionAt.toISOString(),
          },
        };
      },
    );
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Tell the chain what the human decided.
   *
   * The chain does not know a decision happened. A standing `SlashRecord` keeps
   * reserving the provider's stake until somebody says otherwise, and
   * `execute_slash` is permissionless once `executable_at` passes — so an
   * overturn recorded only in Postgres is an overturn a stranger can still
   * execute through. That is what makes the parallel clock safe rather than
   * merely fast.
   *
   * Two outcomes, and only two:
   *
   * - **Overturned** — cancel. The reservation is real money to the provider
   *   (`pending_slash` is subtracted from `withdrawable`), and a case they won
   *   must not go on costing them it until `expire_slash`'s grace runs out ten
   *   days later.
   * - **`UPHELD_RECALCULATED`** — cancel, bump the epoch, propose again.
   *   `record.penalty` is frozen on chain and `execute_slash` takes no amount
   *   argument, so executing the standing record would take **more than the
   *   adjudicator decided**.
   *
   * Everything else — a plain `UPHELD`, or a decision still `AWAITING_SECOND` —
   * leaves the record exactly where it is. `AWAITING_SECOND` matters: a
   * decision nobody has countersigned has resolved nothing, and releasing a
   * reservation on the strength of it would let one reader undo a judgement.
   *
   * ## It is passed `status`, not `input`
   *
   * Because both callers reach it and only one of them has a `DecideInput`.
   * `second()` reads its outcome back off the dispute row, and the branch has
   * to key on what the case actually BECAME rather than on what was asked for.
   *
   * ## Nothing here may throw
   *
   * The override transaction has already committed. An exception escaping into
   * `decide()`'s promise chain would hand the operator a failure for a decision
   * that stands, and they would decide it again.
   *
   * The chain half is therefore best-effort, and both halves are now repaired
   * by a sweep rather than by this request. The **re-propose** waits on
   * `executeDue`'s reservation guard, which fires on the row's own state every
   * tick. The **cancel** cannot happen here at all —
   * `cancel_slash` is signed by `Config.admin`, a person's hardware key — so
   * this records `CANCEL_REQUESTED` and `SlashLifecycleJob`'s admin-cancel
   * sweep carries it: it mirrors `CANCELLED` when the admin signs, and calls
   * the permissionless `expire_slash` if nobody has after the record's
   * seven-day grace. A provider's stake is therefore released without a human
   * in the worst case, which is the property the old best-effort cancel never
   * had.
   */
  private async settleTheChainProposal(
    organizationId: string,
    proposalId: string,
    status: string,
    outcome: ArbitrationOutcome,
  ): Promise<void> {
    if (!this.execution) return;

    try {
      if (status === SlashProposalStatus.OVERTURNED) {
        await this.execution.requestAdminCancel(organizationId, proposalId, outcome);
        return;
      }
      if (
        outcome === ArbitrationOutcome.UPHELD_RECALCULATED &&
        status === SlashProposalStatus.UPHELD
      ) {
        await this.execution.reproposeAtRevisedPenalty(organizationId, proposalId);
      }
    } catch (error) {
      this.logger.error(
        `slash proposal ${proposalId} was decided ${outcome} but its on-chain proposal could ` +
          `not be settled; the decision stands and the chain step will be retried`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * The penalty a decision binds to.
   *
   * Only `UPHELD_RECALCULATED` may change it, and only downwards. Raising it on
   * review would mean the number the provider had a chance to answer was not
   * the number that happens to them — which is the process this arbitration
   * exists to replace, wearing our own uniform.
   */
  private resolvePenalty(proposal: SlashProposalEntity, input: DecideInput): string {
    if (input.outcome !== ArbitrationOutcome.UPHELD_RECALCULATED) {
      return proposal.penaltyAmount;
    }
    const revised = input.recalculatedAmount;
    if (revised === null || revised === undefined) {
      throw SlashErrors.invalidReasonCode({
        outcome: input.outcome,
        code: 'a recalculated amount is required',
      });
    }
    if (BigInt(revised) > BigInt(proposal.penaltyAmount)) {
      throw SlashErrors.recalculationExceedsOriginal({ original: proposal.penaltyAmount });
    }
    return revised;
  }

  /**
   * @param executionAtGuard when given, the write additionally requires that no
   *   on-chain door opens before this moment: the row must not be mid-propose,
   *   and a standing `PENDING` record's `chain_executable_at` must be at or
   *   after it. `NULL >= x` evaluates to NULL and the row does not match, so a
   *   `PENDING` mirror missing its clock fails closed rather than open.
   *   Mirrors {@link extensionRefusal} exactly; only `extendDeadline` passes it.
   */
  private async updateInTransaction(
    queryRunner: QueryRunner,
    organizationId: string,
    proposalId: string,
    expectedFrom: readonly string[],
    patch: Partial<SlashProposalEntity> & { status: string },
    executionAtGuard?: Date,
  ): Promise<number> {
    const query = queryRunner.manager
      .createQueryBuilder()
      .update(SlashProposalEntity)
      .set(patch)
      .where('organization_id = :organizationId', { organizationId })
      .andWhere('id = :proposalId', { proposalId })
      .andWhere('status IN (:...expectedFrom)', { expectedFrom });

    if (executionAtGuard) {
      query
        .andWhere('chain_status <> :proposing', { proposing: ChainProposalStatus.PROPOSING })
        .andWhere('(chain_status <> :pending OR chain_executable_at >= :executionAtGuard)', {
          pending: ChainProposalStatus.PENDING,
          executionAtGuard,
        });
    }

    const result = await query.execute();
    return result.affected ?? 0;
  }

  /**
   * Why an extension may not be granted, or `null` when it may.
   *
   * One place, called twice: by `extendDeadline` against the row it read, and
   * again against the row the write actually found when the CAS lost. Keeping
   * both on one function is what stops the guard and the `WHERE` clause drifting
   * into disagreeing about what they refuse — and the `WHERE` clause in
   * {@link updateInTransaction} is written to mirror the two chain clauses here
   * term for term.
   */
  private extensionRefusal(proposal: SlashProposalEntity, executionAt: Date) {
    if (proposal.status !== SlashProposalStatus.PROPOSED || !proposal.respondByAt) {
      return SlashErrors.notDisputable({ status: proposal.status });
    }
    if (proposal.chainStatus === ChainProposalStatus.PROPOSING) {
      return SlashErrors.extensionWhileProposing({ proposalId: proposal.id });
    }
    if (
      proposal.chainStatus === ChainProposalStatus.PENDING &&
      (!proposal.chainExecutableAt || executionAt.getTime() > proposal.chainExecutableAt.getTime())
    ) {
      return SlashErrors.extensionExceedsChainTimelock({
        proposalId: proposal.id,
        chainExecutableAt: proposal.chainExecutableAt?.toISOString() ?? 'an unrecorded moment',
        requestedExecutionAt: executionAt.toISOString(),
      });
    }
    return null;
  }

  private async writeDisputeDecision(
    queryRunner: QueryRunner,
    proposal: SlashProposalEntity,
    input: DecideInput,
    operator: OperatorSession,
    needsSecond: boolean,
    now: Date,
  ): Promise<void> {
    if (!proposal.disputeId) return;

    await queryRunner.manager.update(
      DisputeEntity,
      { organizationId: proposal.organizationId, id: proposal.disputeId },
      {
        // The polarity flip, in its one place.
        state: needsSecond ? 'UNDER_REVIEW' : ARBITRATION_STATE_MAP[input.outcome],
        outcome: input.outcome,
        reasonCodes: [...input.reasonCodes],
        rubricVersion: CURRENT_RUBRIC_VERSION,
        resolutionKind: needsSecond ? null : ResolutionKind.ADJUDICATOR,
        resolvedAt: needsSecond ? null : now,
        resolvedBy: needsSecond ? null : operator.subject,
        resolutionNote: input.note,
      },
    );
  }

  /**
   * What follows from an outcome, read off the consequence table rather than
   * restated here.
   *
   * `strikesStand: false` moves the strike to `OVERTURNED`, which is what
   * the dispute case screen's restoration record promises and what the routing
   * weight is eventually computed from. `raisesSamplingToFull` has no writer
   * yet and is recorded as such: `deriveSampleRate`'s only caller passes no
   * overrides, and that single unthreaded line is the same seam
   * `EXPLORING_BINDING` and `sampling_escalation_requested` are already waiting on.
   */
  private async applyConsequences(
    queryRunner: QueryRunner,
    proposal: SlashProposalEntity,
    outcome: ArbitrationOutcome,
  ): Promise<void> {
    const consequence = OUTCOME_CONSEQUENCE[outcome];

    if (proposal.strikeId) {
      /*
        The target is the ENTITY, not the table name, and the criteria are
        PROPERTY names, not column names.

        `manager.update('sla_strikes', { organization_id: … })` resolves the
        string to `SlaStrikeEntity` and then looks for a property called
        `organization_id`, which does not exist — it fails at runtime with
        `Property "organization_id" was not found in "SlaStrikeEntity"`.
        Passing the class makes the same mistake a compile error instead.

        Never executed before: this runs only when a decision binds, and every
        decision that needed a second signature failed earlier on a CHECK
        constraint. See the note in `decide`.
      */
      await queryRunner.manager.update(
        SlaStrikeEntity,
        { organizationId: proposal.organizationId, id: proposal.strikeId },
        { status: consequence.strikesStand ? 'UPHELD' : 'OVERTURNED' },
      );
    }
  }

  private async notifyDecision(
    proposal: SlashProposalEntity,
    outcome: ArbitrationOutcome,
  ): Promise<void> {
    const overturned = isOverturn(outcome);
    await this.notifications.notify({
      organizationId: proposal.organizationId,
      event: NotificationEvent.PROVIDER_SLASH_DECIDED,
      title: overturned
        ? 'A proposed penalty against your stake was cancelled'
        : 'A proposed penalty against your stake was upheld',
      body: overturned
        ? 'Your objection was upheld. Nothing will be taken, and the case page lists what was ' +
          'restored.'
        : `The proposal stands at ${proposal.penaltyAmount}. Nothing executes before ` +
          `${proposal.earliestExecutionAt.toISOString()}.`,
      subjectType: 'slash_proposal',
      subjectId: proposal.id,
      dedupeKey: `${proposal.id}:decided`,
      payload: {
        proposalId: proposal.id,
        outcome,
        overturned,
        penaltyAmount: proposal.penaltyAmount,
      },
    });
  }
}
