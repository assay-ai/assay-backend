import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { In, IsNull, QueryRunner } from 'typeorm';

import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { SlaWindowCallRepository } from '@database/postgres/repositories/sla-window-call.repository';
import { SlashProposalPartRepository } from '@database/postgres/repositories/slash-proposal-part.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import {
  AssetId,
  ChainNamespace,
  chainIdOf,
  namespaceOf,
  parseAccountId,
} from '@modules/chains/ports/caip.types';
import { OperatorApprover, OperatorSession } from '@modules/operator/ports/operator-session.port';
import { OverrideLogService } from '@modules/operator/services/override-log.service';

import { ChainProposalStatus } from '../domain/chain-slash-outcome';
import { normalizeAgentAccount } from '../domain/prorata-slash';
import { SlashProposalStatus } from '../domain/slash-proposal-state';
import {
  ChainRecordState,
  classifyRecord,
  CLOSABLE_STATUSES,
  StuckCaseAction,
  StuckCaseRead,
  stuckCaseRefusal,
} from '../domain/stuck-case';
import { SlashErrorCode, SlashErrors } from '../errors/slash.errors';
import { SLASH_EXECUTOR, SlashExecutorPort } from '../ports/slash-executor.port';
import { reproposalEpochPatch, SlashExecutionService } from './slash-execution.service';
import { SlashProposalService } from './slash-proposal.service';

/** An action waits no longer than this for its fresh chain read; past it, it is refused. */
export const ACTION_CHAIN_READ_TIMEOUT_MS = 10_000;

/**
 * The advisory-lock namespace of the manual case actions. One transaction per
 * case at a time takes it (`pg_advisory_xact_lock(ns, hashtext(id))`), so two
 * operators (or two approvals of one request) acting on the same case run
 * one after the other, and the second re-reads what the first left.
 */
const MANUAL_ACTION_LOCK_NAMESPACE = 18_018;

/** What the operator wrote, as every override records it. */
export interface ManualActionInput {
  readonly reasonCode: string;
  readonly note: string;
  readonly ticketRef?: string | null;
}

/**
 * The case as the request saw it. An approval runs against the case only while
 * it is still this one: a case re-proposed or closed since is a different
 * question, and the second person never approves an action on it blind.
 */
export interface ManualActionExpectation {
  readonly chainEpoch: number;
  readonly chainRequestId: string;
}

export interface ManualActionResult {
  readonly proposalId: string;
  readonly status: string;
  readonly chainStatus: string;
  readonly chainEpoch: number;
  /** A repeat of an action that already ran (a double submit): nothing more was written. */
  readonly alreadyDone?: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A stuck case's own record, read live (see `slash/domain/stuck-case.ts`).
 * `null` when the case is not a stuck shape — a single record or a case with
 * parts, which the admin-cancel sweep settles from its own read. Never throws:
 * a read that fails or times out is `unreadable`.
 *
 * Shared by the case brief (a short timeout; it only shows) and the actions
 * (a fresh read immediately before acting).
 */
export async function readStuckCaseRecord(
  deps: {
    readonly parts: Pick<SlashProposalPartRepository, 'findForEpoch'>;
    readonly enrolments: Pick<ProviderChainEnrolmentRepository, 'findOneBy'>;
    readonly executor: Pick<SlashExecutorPort, 'readRecord'> | null;
    readonly logger: Logger;
    /** The window's payers, to check an executed record's beneficiary (m5). Absent: unchecked. */
    readonly windowCalls?: Pick<SlaWindowCallRepository, 'sumFailedPriceByAgent'> | null;
  },
  proposal: SlashProposalEntity,
  timeoutMs: number,
  // The actions read as of the finalized block (review m3); the brief only shows.
  options: { readonly finalized?: boolean } = {},
): Promise<StuckCaseRead | null> {
  const partitioned =
    proposal.windowId !== null &&
    namespaceOf(proposal.assetId as AssetId) === ChainNamespace.EIP155;
  if (!partitioned) return null;
  const parts = await deps.parts.findForEpoch(
    proposal.organizationId,
    proposal.id,
    proposal.chainEpoch,
  );
  if (parts.length > 0) return null;

  const unreadable: StuckCaseRead = {
    state: ChainRecordState.UNKNOWN,
    record: null,
    unreadable: true,
  };
  if (!deps.executor) return unreadable;
  try {
    const chainId = chainIdOf(proposal.assetId as AssetId);
    const enrolment = await deps.enrolments.findOneBy({
      organizationId: proposal.providerId,
      chainId,
    });
    if (!enrolment?.stakeAuthorityAccountId) return unreadable;
    const record = await withTimeout(
      deps.executor.readRecord(
        proposal.chainRequestId,
        parseAccountId(enrolment.stakeAuthorityAccountId).address,
        chainId,
        options.finalized ? { finalized: true } : undefined,
      ),
      timeoutMs,
    );
    const state = classifyRecord(record, proposal.chainProposedAt);
    if (record?.status !== 'EXECUTED' || !deps.windowCalls) {
      return { state, record, unreadable: false };
    }
    // Who the contract paid the agent share to. A legacy single record may
    // name a vault, escrow or treasury: then no agent was paid, and recording
    // it (whose compensation books nothing for this shape) would leave that
    // money credited to nobody.
    const payers = await deps.windowCalls.sumFailedPriceByAgent(
      proposal.windowId as string,
      proposal.assetId,
      proposal.providerId,
    );
    const beneficiary = record.beneficiary
      ? normalizeAgentAccount(`${chainId}:${record.beneficiary}`)
      : null;
    const beneficiaryIsAgent =
      beneficiary !== null &&
      payers.some((row) => normalizeAgentAccount(row.agentAccount) === beneficiary);
    return { state, record, unreadable: false, beneficiaryIsAgent };
  } catch (error) {
    deps.logger.warn(
      `slash proposal ${proposal.id}: its on-chain record could not be read ` +
        `(${error instanceof Error ? error.message : String(error)}); shown as unknown`,
    );
    return unreadable;
  }
}

/**
 * B18 (owner-approved 2026-10-18): the operator's three explicit actions for a
 * case stuck behind a requested cancel that the admin-cancel sweep cannot
 * settle. Never automatic: each runs only from an operator's request, and the
 * two that record money or reserve stake only with a second operator's
 * approval (`S-16`, `S-17`).
 *
 * ## What every action does, in this order
 *
 * 1. Re-reads the case and, when an approval is being run, checks it is still
 *    the case that was asked about (same epoch and request id).
 * 2. Reads the record on chain, live, immediately before acting. A read that
 *    fails, times out, or cannot be told (a written record not found) refuses.
 * 3. Checks the guard on that read (`stuckCaseRefusal`).
 * 4. In ONE transaction, through `OverrideLogService.perform` (which marks the
 *    approval `APPROVED` in it and writes the override register row): takes
 *    the case's manual-action lock, re-checks the case, writes with a
 *    compare-and-set on its status, chain mirror, epoch and request id, and
 *    appends the case timeline row. Any miss rolls all of it back.
 *
 * ## Against the sweeps
 *
 * Nothing else writes a stuck case's chain state: the admin-cancel sweep reads
 * it as `null` and only notes `SlashNotPending` (now a compare-and-set on the
 * mirror it read, so the note never lands after an operator closed it); the
 * execute, external-execution and closed-still-pending sweeps select
 * `PENDING`/`DISPUTED` mirrors; the watcher finds no part and its case-level
 * mirror reads the same `null`. Each sweep write is one statement on the case
 * row and waits on no other lock, so the order here — approval row, then the
 * case's advisory lock, then the case row — cannot deadlock against them.
 */
@Injectable()
export class SlashStuckCaseService {
  private readonly logger = new Logger(SlashStuckCaseService.name);

  constructor(
    private readonly proposals: SlashProposalRepository,
    private readonly parts: SlashProposalPartRepository,
    private readonly enrolments: ProviderChainEnrolmentRepository,
    private readonly lifecycle: SlashProposalService,
    private readonly overrides: OverrideLogService,
    private readonly execution: SlashExecutionService,
    @Optional() @Inject(SLASH_EXECUTOR) private readonly executor: SlashExecutorPort | null = null,
    @Optional() private readonly windowCalls: SlaWindowCallRepository | null = null,
  ) {}

  /**
   * The live read, for the brief (`latest`, a short timeout: it only shows)
   * and the actions (`finalized`: what they act on must not be undone by a
   * reorg).
   */
  readLive(
    proposal: SlashProposalEntity,
    timeoutMs: number,
    options: { readonly finalized?: boolean } = {},
  ): Promise<StuckCaseRead | null> {
    return readStuckCaseRecord(
      {
        parts: this.parts,
        enrolments: this.enrolments,
        executor: this.executor,
        logger: this.logger,
        windowCalls: this.windowCalls,
      },
      proposal,
      timeoutMs,
      options,
    );
  }

  /** The case's epoch and request id now, for an approval's payload. */
  async expectationOf(
    organizationId: string,
    proposalId: string,
  ): Promise<ManualActionExpectation> {
    const proposal = await this.require(organizationId, proposalId);
    return { chainEpoch: proposal.chainEpoch, chainRequestId: proposal.chainRequestId };
  }

  /**
   * `S-15`: the record reads `Cancelled` on chain and the case is closed with
   * no penalty, so the requested cancel is closed: the mirror moves to
   * `CANCELLED` (what the sweep writes when it can read the record), with a
   * `CHAIN_CANCELLED` timeline row. No money moves and nothing is sent.
   */
  async closeNothingStanding(
    operator: OperatorSession,
    organizationId: string,
    proposalId: string,
    input: ManualActionInput,
    requestId: string | null,
  ): Promise<ManualActionResult> {
    const action: StuckCaseAction = 'CLOSE_NOTHING_STANDING';
    const proposal = await this.require(organizationId, proposalId);
    // A repeat of a close that already ran (another tab, another operator):
    // the same answer, and nothing written twice (review m7).
    const done = await this.alreadyClosed(proposal, proposal);
    if (done) return done;
    const read = await this.freshRead(action, proposal);

    try {
      return await this.closeOnce(
        operator,
        organizationId,
        proposalId,
        input,
        requestId,
        proposal,
        read,
      );
    } catch (error) {
      // Lost the compare-and-set to a sibling close of the same epoch: that one closed it.
      if (isRefusal(error, 'CHANGED')) {
        const now = await this.proposals.findOneScoped(organizationId, proposalId);
        const sibling = now ? await this.alreadyClosed(proposal, now) : null;
        if (sibling) return sibling;
      }
      throw error;
    }
  }

  /**
   * The case as closed by an earlier `S-15` of the same epoch and request id,
   * or `null`. Read from the row and the timeline entry that close wrote.
   */
  private async alreadyClosed(
    asked: SlashProposalEntity,
    now: SlashProposalEntity,
  ): Promise<ManualActionResult | null> {
    if (
      now.chainStatus !== ChainProposalStatus.CANCELLED ||
      now.chainEpoch !== asked.chainEpoch ||
      now.chainRequestId !== asked.chainRequestId ||
      !(await this.lifecycle.hasTimelineEntry(
        now.organizationId,
        now.id,
        'CHAIN_CANCELLED',
        now.chainRequestId,
      ))
    ) {
      return null;
    }
    return {
      proposalId: now.id,
      status: now.status,
      chainStatus: now.chainStatus,
      chainEpoch: now.chainEpoch,
      alreadyDone: true,
    };
  }

  private closeOnce(
    operator: OperatorSession,
    organizationId: string,
    proposalId: string,
    input: ManualActionInput,
    requestId: string | null,
    proposal: SlashProposalEntity,
    read: StuckCaseRead,
  ): Promise<ManualActionResult> {
    const action: StuckCaseAction = 'CLOSE_NOTHING_STANDING';
    return this.overrides.perform<ManualActionResult>(
      {
        code: 'S-15',
        actor: operator,
        approver: null,
        targetType: 'slash_proposal',
        targetId: proposalId,
        organizationId,
        reasonCode: input.reasonCode,
        reason: input.note,
        ticketRef: input.ticketRef ?? null,
        requestId,
      },
      async (queryRunner) => {
        await this.lockCase(queryRunner, proposalId);
        const moved = await queryRunner.manager.update(
          SlashProposalEntity,
          {
            ...this.sameCase(proposal),
            status: In([...CLOSABLE_STATUSES]),
            executedAt: IsNull(),
          },
          { chainStatus: ChainProposalStatus.CANCELLED, chainLastError: null },
        );
        if (!moved.affected) throw this.changed(action, proposalId, read);

        await this.lifecycle.appendEvent(queryRunner, {
          organizationId,
          proposalId,
          occurredAt: new Date(),
          kind: 'CHAIN_CANCELLED',
          actorType: 'operator',
          actorId: operator.subject,
          summary:
            'Its on-chain record reads cancelled and nothing of it stands, so the requested ' +
            'cancel is closed. Nothing was taken from the provider.',
          detail: this.readDetail(proposal, read, 'S-15'),
        });
        return {
          value: {
            proposalId,
            status: proposal.status,
            chainStatus: ChainProposalStatus.CANCELLED,
            chainEpoch: proposal.chainEpoch,
          },
          before: { status: proposal.status, chainStatus: proposal.chainStatus },
          after: {
            status: proposal.status,
            chainStatus: ChainProposalStatus.CANCELLED,
            chainRead: read.record?.status ?? null,
          },
        };
      },
    );
  }

  /**
   * `S-16`: the record reads `Executed` on chain while the cancel waited.
   * The execution is recorded through the existing
   * `recordAnExecutionNobodyAskedFor` (no new money path), inside the case's
   * lock, and the override row is written only once the row says it.
   */
  async recordExecution(
    operator: OperatorSession,
    approver: OperatorApprover | null,
    organizationId: string,
    proposalId: string,
    input: ManualActionInput,
    expected: ManualActionExpectation | null,
    requestId: string | null,
  ): Promise<ManualActionResult> {
    const action: StuckCaseAction = 'RECORD_EXECUTION';
    const proposal = await this.require(organizationId, proposalId);
    this.assertExpected(action, proposal, expected);
    const read = await this.freshRead(action, proposal);
    const record = read.record!;
    // The provider's notice, sent only once everything below has committed.
    let afterCommit: (() => Promise<void>) | null = null;

    const result = await this.overrides.perform<ManualActionResult>(
      {
        code: 'S-16',
        actor: operator,
        approver,
        targetType: 'slash_proposal',
        targetId: proposalId,
        organizationId,
        reasonCode: input.reasonCode,
        reason: input.note,
        ticketRef: input.ticketRef ?? null,
        requestId,
        // What the chain took: the money this records.
        amountMinor: record.appliedMinor,
      },
      async (queryRunner) => {
        await this.lockCase(queryRunner, proposalId);
        // Re-read under the lock: a second request for this case waited here,
        // and finds the execution already recorded.
        const fresh = await queryRunner.manager.findOne(SlashProposalEntity, {
          where: { organizationId, id: proposalId },
        });
        if (
          !fresh ||
          fresh.chainEpoch !== proposal.chainEpoch ||
          fresh.chainRequestId !== proposal.chainRequestId
        ) {
          throw this.changed(action, proposalId, read);
        }
        const refusal = stuckCaseRefusal(action, fresh, read);
        if (refusal) throw this.refused(action, proposalId, refusal, read);

        await this.lifecycle.appendEvent(queryRunner, {
          organizationId,
          proposalId,
          occurredAt: new Date(),
          kind: 'EXECUTION_RECORDED_BY_OPERATOR',
          actorType: 'operator',
          actorId: operator.subject,
          summary:
            'Its on-chain record reads executed: the penalty was taken while the cancel waited. ' +
            'The execution is recorded on the case.',
          detail: {
            ...this.readDetail(fresh, read, 'S-16'),
            applied: record.appliedMinor,
            beneficiary: record.beneficiary ?? null,
          },
        });

        // The existing path, written in THIS transaction (review M1): the
        // recorded execution, the approval and the register row commit
        // together or not at all.
        ({ afterCommit } = await this.execution.recordExecutionWhileCancelWaited(
          fresh,
          record,
          queryRunner,
        ));

        const after = await queryRunner.manager.findOne(SlashProposalEntity, {
          where: { organizationId, id: proposalId },
        });
        if (!after?.executedAt) {
          // The path refused to write it (it logged why): nothing to record.
          throw this.refused(action, proposalId, 'CASE_STATUS', read);
        }
        return {
          value: {
            proposalId,
            status: after.status,
            chainStatus: after.chainStatus,
            chainEpoch: after.chainEpoch,
          },
          before: { status: fresh.status, chainStatus: fresh.chainStatus, executedAt: null },
          after: {
            status: after.status,
            chainStatus: after.chainStatus,
            executedAt: after.executedAt.toISOString(),
            applied: record.appliedMinor,
          },
        };
      },
    );
    await (afterCommit as (() => Promise<void>) | null)?.();
    return result;
  }

  /**
   * `S-17`: the old record reads `Cancelled` and the case is still `UPHELD`
   * (a downward recalculation whose cancel the sweep could not mirror). The
   * case moves to a fresh epoch, unproposed — the same row
   * `reproposeAfterCancellation` writes — and the scheduler's propose sweep
   * proposes it with every one of its guards (the claim, the live stake and
   * caps, the derived request id, the promise to the provider). No chain write
   * is made from this request.
   */
  async repropose(
    operator: OperatorSession,
    approver: OperatorApprover | null,
    organizationId: string,
    proposalId: string,
    input: ManualActionInput,
    expected: ManualActionExpectation | null,
    requestId: string | null,
  ): Promise<ManualActionResult> {
    const action: StuckCaseAction = 'REPROPOSE';
    const proposal = await this.require(organizationId, proposalId);
    this.assertExpected(action, proposal, expected);
    const read = await this.freshRead(action, proposal);
    const patch = reproposalEpochPatch(proposal);

    return this.overrides.perform<ManualActionResult>(
      {
        code: 'S-17',
        actor: operator,
        approver,
        targetType: 'slash_proposal',
        targetId: proposalId,
        organizationId,
        reasonCode: input.reasonCode,
        reason: input.note,
        ticketRef: input.ticketRef ?? null,
        requestId,
        // What it puts back on chain against the provider's stake.
        amountMinor: proposal.penaltyAmount,
      },
      async (queryRunner) => {
        await this.lockCase(queryRunner, proposalId);
        const moved = await queryRunner.manager.update(
          SlashProposalEntity,
          {
            ...this.sameCase(proposal),
            status: SlashProposalStatus.UPHELD,
            executedAt: IsNull(),
            // B7: a case the provider won a dispute of is never proposed again.
            chainDisputeWonAt: IsNull(),
          },
          patch,
        );
        if (!moved.affected) throw this.changed(action, proposalId, read);

        const now = new Date();
        await this.lifecycle.appendEvent(queryRunner, {
          organizationId,
          proposalId,
          occurredAt: now,
          kind: 'CHAIN_CANCELLED',
          actorType: 'operator',
          actorId: operator.subject,
          summary:
            'Its earlier on-chain record reads cancelled, so its reservation is released and the ' +
            'decided penalty can be proposed in its place.',
          detail: this.readDetail(proposal, read, 'S-17'),
        });
        await this.lifecycle.appendEvent(queryRunner, {
          organizationId,
          proposalId,
          occurredAt: now,
          kind: 'REPROPOSAL_REQUESTED',
          actorType: 'operator',
          actorId: operator.subject,
          summary:
            'The decided penalty is to be proposed on chain again under a new request id; it ' +
            'goes on chain with the next proposal pass.',
          detail: {
            fromEpoch: proposal.chainEpoch,
            toEpoch: patch.chainEpoch,
            requestId: patch.chainRequestId,
            penalty: proposal.penaltyAmount,
          },
        });
        return {
          value: {
            proposalId,
            status: proposal.status,
            chainStatus: ChainProposalStatus.NONE,
            chainEpoch: patch.chainEpoch,
          },
          before: {
            chainStatus: proposal.chainStatus,
            chainEpoch: proposal.chainEpoch,
            chainRequestId: proposal.chainRequestId,
          },
          after: {
            chainStatus: ChainProposalStatus.NONE,
            chainEpoch: patch.chainEpoch,
            chainRequestId: patch.chainRequestId,
            chainRead: read.record?.status ?? null,
          },
        };
      },
    );
  }

  // ── shared ──────────────────────────────────────────────────────────────

  private async require(organizationId: string, proposalId: string): Promise<SlashProposalEntity> {
    const proposal = await this.proposals.findOneScoped(organizationId, proposalId);
    if (!proposal) throw SlashErrors.proposalNotFound({ proposalId });
    return proposal;
  }

  /** The fresh read the action runs on, refused unless its guard holds. */
  private async freshRead(
    action: StuckCaseAction,
    proposal: SlashProposalEntity,
  ): Promise<StuckCaseRead> {
    // Cheap refusals first: no chain read for a case that is not stuck at all.
    if (proposal.chainStatus !== ChainProposalStatus.CANCEL_REQUESTED) {
      throw this.refused(action, proposal.id, 'NOT_CANCEL_REQUESTED', null);
    }
    const read = await this.readLive(proposal, ACTION_CHAIN_READ_TIMEOUT_MS, { finalized: true });
    if (read?.unreadable) {
      throw SlashErrors.chainUnavailable({
        proposalId: proposal.id,
        reason: 'its on-chain record could not be read just now, so nothing was changed',
      });
    }
    const refusal = stuckCaseRefusal(action, proposal, read);
    if (refusal) throw this.refused(action, proposal.id, refusal, read);
    return read as StuckCaseRead;
  }

  private assertExpected(
    action: StuckCaseAction,
    proposal: SlashProposalEntity,
    expected: ManualActionExpectation | null,
  ): void {
    if (
      expected &&
      (proposal.chainEpoch !== expected.chainEpoch ||
        proposal.chainRequestId !== expected.chainRequestId)
    ) {
      throw this.changed(action, proposal.id, null);
    }
  }

  /** The compare-and-set predicate: the case exactly as it was read. */
  private sameCase(proposal: SlashProposalEntity) {
    return {
      organizationId: proposal.organizationId,
      id: proposal.id,
      chainStatus: ChainProposalStatus.CANCEL_REQUESTED,
      chainEpoch: proposal.chainEpoch,
      chainRequestId: proposal.chainRequestId,
    };
  }

  private async lockCase(queryRunner: QueryRunner, proposalId: string): Promise<void> {
    await queryRunner.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
      MANUAL_ACTION_LOCK_NAMESPACE,
      proposalId,
    ]);
  }

  private readDetail(proposal: SlashProposalEntity, read: StuckCaseRead, code: string) {
    return {
      requestId: proposal.chainRequestId,
      chainEpoch: proposal.chainEpoch,
      read: read.record?.status ?? null,
      cancelReason: read.record?.cancelReason ?? null,
      cancelledAt: read.record?.cancelledAt?.toISOString() ?? null,
      executedAt: read.record?.executedAt?.toISOString() ?? null,
      override: code,
    };
  }

  private refused(
    action: StuckCaseAction,
    proposalId: string,
    reason: string,
    read: StuckCaseRead | null,
  ) {
    return SlashErrors.manualActionRefused({
      proposalId,
      action,
      reason,
      chainRecord: read?.state ?? null,
    });
  }

  /** The case moved since it was read (another operator, an approval, or a sweep). */
  private changed(action: StuckCaseAction, proposalId: string, read: StuckCaseRead | null) {
    return this.refused(action, proposalId, 'CHANGED', read);
  }
}

function isRefusal(error: unknown, reason: string): boolean {
  const context = (error as { publicContext?: Record<string, unknown> } | null)?.publicContext;
  return (
    (error as { errorCode?: string } | null)?.errorCode ===
      SlashErrorCode.SLASH_MANUAL_ACTION_REFUSED && context?.reason === reason
  );
}
