import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { SlashProposalPartRepository } from '@database/postgres/repositories/slash-proposal-part.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { CursorPageDto } from '@shared/api';
import {
  AssetId,
  ChainNamespace,
  chainIdOf,
  namespaceOf,
  parseAccountId,
} from '@modules/chains/ports/caip.types';
import { ChainProposalStatus } from '@modules/slash/domain/chain-slash-outcome';
import { alertExecutedWhileCancelWaited } from '@modules/slash/domain/executed-while-cancel-waited';
import { ALERT_PORT, AlertPort } from '@shared/alerting';
import { ArbitrationService } from '@modules/slash/services/arbitration.service';
import { SlashExecutionService } from '@modules/slash/services/slash-execution.service';
import { SlashErrors } from '@modules/slash/errors/slash.errors';
import {
  SLASH_EXECUTOR,
  SlashCancelIntent,
  SlashCompensationIntent,
  SlashExecutorPort,
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
/** What stands on chain for a case, as the brief says it (`chainRecord`). */
export enum ChainRecordState {
  STANDING = 'STANDING',
  EXECUTED = 'EXECUTED',
  GONE = 'GONE',
  UNKNOWN = 'UNKNOWN',
}

/** The case page waits no longer than this for a live chain read. */
const BRIEF_CHAIN_READ_TIMEOUT_MS = 2_500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The mirrors under which a record of the case may still stand on chain. */
const MAY_STAND: readonly string[] = [
  ChainProposalStatus.PENDING,
  ChainProposalStatus.DISPUTED,
  ChainProposalStatus.CANCEL_REQUESTED,
];

@Injectable()
export class OperatorCaseService {
  private readonly logger = new Logger(OperatorCaseService.name);

  constructor(
    private readonly proposals: SlashProposalRepository,
    private readonly queue: AdjudicationQueueService,
    private readonly arbitration: ArbitrationService,
    private readonly execution: SlashExecutionService,
    private readonly approvals: OperatorApprovalService,
    private readonly parts: SlashProposalPartRepository,
    private readonly enrolments: ProviderChainEnrolmentRepository,
    @Optional() @Inject(SLASH_EXECUTOR) private readonly executor: SlashExecutorPort | null = null,
    @Optional() @Inject(ALERT_PORT) private readonly alerts: AlertPort | null = null,
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
    const [brief, proposal] = await Promise.all([
      this.queue.brief(organizationId, proposalId),
      this.proposals.findOneScoped(organizationId, proposalId),
    ]);
    const chainRecord = proposal ? await this.chainRecordOf(proposal) : ChainRecordState.GONE;
    // A withdrawn judgement executed while its cancel waited: the console shows it, so it is paged
    // too (once per case; the cancel route raises the same alert). Nothing is written.
    if (
      proposal &&
      chainRecord === ChainRecordState.EXECUTED &&
      proposal.chainStatus === ChainProposalStatus.CANCEL_REQUESTED
    ) {
      await alertExecutedWhileCancelWaited(this.alerts, this.logger, proposal, 'record');
    }
    return {
      ...brief,
      // What stands on chain for this case: STANDING (anyone could execute it
      // once due; a cancel has something to act on), EXECUTED (the stake was
      // taken, even under a requested cancel), GONE (nothing stands and nothing
      // was taken), UNKNOWN (could not be told; read as standing).
      // `chainExecutableAt` alone cannot say any of this: a case opened before
      // the parts model keeps its dates with nothing behind them.
      chainRecord,
      // STANDING or UNKNOWN. Kept beside `chainRecord` for the console's simple reads.
      chainStanding:
        chainRecord === ChainRecordState.STANDING || chainRecord === ChainRecordState.UNKNOWN,
    };
  }

  /**
   * Read, never assumed; anything that cannot be told is UNKNOWN:
   *
   * - mirror `EXECUTED`: EXECUTED; any other mirror that cannot carry a record
   *   (`NONE`, `PROPOSING`, `REFUSED`, `CANCELLED`): GONE;
   * - a partitioned case (an EVM window) with parts, from the stored parts the
   *   sweeps keep in step: a part PENDING or DISPUTED is STANDING, else one
   *   EXECUTED is EXECUTED, else a part NONE or REFUSED is UNKNOWN (it may
   *   still land; the sweep re-reads it), else GONE;
   * - a partitioned case with **no** parts (opened before the parts model):
   *   its judgement is the one record under the case's own request id, read
   *   from the chain with a short timeout. No record is GONE only when none
   *   was ever written; one that was written and is not found is an anomaly,
   *   UNKNOWN;
   * - a single-record case: STANDING (its mirror, kept in step by the sweeps).
   */
  private async chainRecordOf(proposal: SlashProposalEntity): Promise<ChainRecordState> {
    if (proposal.chainStatus === ChainProposalStatus.EXECUTED) return ChainRecordState.EXECUTED;
    if (!MAY_STAND.includes(proposal.chainStatus)) return ChainRecordState.GONE;
    const partitioned =
      proposal.windowId !== null &&
      namespaceOf(proposal.assetId as AssetId) === ChainNamespace.EIP155;
    if (!partitioned) return ChainRecordState.STANDING;

    const parts = await this.parts.findForEpoch(
      proposal.organizationId,
      proposal.id,
      proposal.chainEpoch,
    );
    if (parts.length > 0) {
      const has = (status: string) => parts.some((part) => part.chainStatus === status);
      if (has('PENDING') || has('DISPUTED')) return ChainRecordState.STANDING;
      if (has('EXECUTED')) return ChainRecordState.EXECUTED;
      if (has('NONE') || has('REFUSED')) return ChainRecordState.UNKNOWN;
      return ChainRecordState.GONE;
    }

    if (!this.executor) return ChainRecordState.UNKNOWN;
    try {
      const chainId = chainIdOf(proposal.assetId as AssetId);
      const enrolment = await this.enrolments.findOneBy({
        organizationId: proposal.providerId,
        chainId,
      });
      if (!enrolment?.stakeAuthorityAccountId) return ChainRecordState.UNKNOWN;
      const record = await withTimeout(
        this.executor.readRecord(
          proposal.chainRequestId,
          parseAccountId(enrolment.stakeAuthorityAccountId).address,
          chainId,
        ),
        BRIEF_CHAIN_READ_TIMEOUT_MS,
      );
      if (record?.status === 'PENDING' || record?.status === 'DISPUTED') {
        return ChainRecordState.STANDING;
      }
      if (record?.status === 'EXECUTED') return ChainRecordState.EXECUTED;
      if (record?.status === 'CANCELLED') return ChainRecordState.GONE;
      return proposal.chainProposedAt ? ChainRecordState.UNKNOWN : ChainRecordState.GONE;
    } catch (error) {
      this.logger.warn(
        `slash proposal ${proposal.id}: its on-chain record could not be read for the brief ` +
          `(${error instanceof Error ? error.message : String(error)}); shown as unknown`,
      );
      return ChainRecordState.UNKNOWN;
    }
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
