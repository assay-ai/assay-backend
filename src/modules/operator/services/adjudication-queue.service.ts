import { Injectable } from '@nestjs/common';

import { DisputeEntity } from '@database/postgres/entities/dispute.entity';
import { DisputeRepository } from '@database/postgres/repositories/dispute.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { CursorPageDto, ListSpec, asInstant, paginate } from '@shared/api';
import { DisputeClaimType } from '@modules/slash/domain/arbitration';
import { SlashProposalStatus } from '@modules/slash/domain/slash-proposal-state';
import { SlashCaseService } from '@modules/slash/services/slash-case.service';

import { AdjudicationQueueRowDto, ListQueueQueryDto } from '../dto/operator-console.dto';
import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import { OperatorSession } from '../ports/operator-session.port';

/**
 * The adjudication queue, and the case brief.
 *
 * ## The ordering is the requirement
 *
 * *"Ordered by time remaining, then by penalty amount — not FIFO."* The
 * ordering lives in `QUEUE_LIST`'s `defaultSort` and the partial index behind
 * rather than here, so a caller cannot re-sort it into FIFO by passing a
 * parameter. The reason: FIFO against a hard deadline guarantees the
 * oldest case expires first, and the platform-miss rule then overturns it
 * against us. Insertion order is not a neutral default here; it is a choice to
 * lose the cases we have held longest.
 *
 * ## Two columns exist because they settle most cases
 *
 * `coFailureCount` and `rootCauseGroupSize` are on the *row*, not behind a
 * click. The co-failure panel comes first among the things an adjudicator
 * must be looking at — *"this alone would resolve most platform-defect cases in
 * seconds"* — so it sits *"right on the row"*. A
 * signal that costs a navigation is a signal that gets used on the cases
 * somebody already suspected, which is the opposite of what it is for.
 */
@Injectable()
export class AdjudicationQueueService {
  constructor(
    private readonly proposals: SlashProposalRepository,
    private readonly disputes: DisputeRepository,
    private readonly providers: ProviderRepository,
    private readonly operators: OperatorRepository,
    private readonly cases: SlashCaseService,
  ) {}

  async list(
    operator: OperatorSession,
    query: ListQueueQueryDto,
  ): Promise<CursorPageDto<AdjudicationQueueRowDto>> {
    const page = await paginate(this.proposals.queueQueryBuilder(), query, QUEUE_LIST);

    const disputeIds = page.items
      .map((row) => row.disputeId)
      .filter((id): id is string => id !== null);

    const [disputes, providerNames, groupSizes] = await Promise.all([
      this.loadDisputes(
        page.items.map((r) => r.organizationId),
        disputeIds,
      ),
      this.loadProviderNames(page.items.map((r) => ({ org: r.organizationId, id: r.providerId }))),
      this.proposals.rootCauseGroupSizes(
        page.items.map((r) => r.rootCauseKey).filter((k): k is string => k !== null),
      ),
    ]);

    const now = Date.now();
    const items: AdjudicationQueueRowDto[] = [];

    for (const row of page.items) {
      const dispute = row.disputeId ? disputes.get(row.disputeId) : undefined;
      const owner = dispute?.assignedOperatorId
        ? await this.operators.findById(dispute.assignedOperatorId)
        : null;

      const dueAt = row.platformDecisionDueAt;
      const secondsToDeadline = dueAt
        ? Math.max(0, Math.floor((dueAt.getTime() - now) / 1000))
        : null;

      items.push({
        proposalId: row.id,
        caseLabel: await this.cases.caseLabel(row.organizationId, row.id),
        disputeId: row.disputeId,
        providerId: row.providerId,
        providerName: providerNames.get(row.providerId) ?? row.providerId,
        penaltyAmount: {
          amount: row.penaltyAmount,
          asset: row.assetId,
          decimals: row.decimals,
        },
        claimType: (dispute?.claimType as DisputeClaimType | undefined) ?? null,
        status: row.status as SlashProposalStatus,
        dueAt,
        secondsToDeadline,
        // Past the deadline and still open. The sweeper will overturn it on its
        // next tick; showing it as overdue rather than hiding it is deliberate,
        // because the number of rows in this state is the staffing signal that
        // must stay visible.
        overdue: dueAt !== null && dueAt.getTime() <= now,
        ownerSubject: owner?.subject ?? null,
        rootCauseKey: row.rootCauseKey,
        rootCauseGroupSize: row.rootCauseKey ? (groupSizes.get(row.rootCauseKey) ?? 1) : 1,
        coFailureCount: await this.cases.coFailureCount(row.organizationId, row.id),
      });
    }

    return new CursorPageDto(this.applyFilters(items, operator, query), page.pageInfo.nextCursor);
  }

  /**
   * Filters applied after the page, not inside the query.
   *
   * A deliberate trade and worth naming: `mine`, `unassigned` and `overdue` all
   * key on the dispute row and the wall clock, and pushing them into the
   * keyset query would need either a join that defeats the index the ordering
   * depends on, or a second cursor space per filter combination. At the volumes
   * expected — a queue measured in tens of open cases, not thousands — a
   * post-filter costs a short page and nothing else.
   *
   * It **does** mean a filtered page can come back shorter than `limit` while
   * `hasMore` is true. That is exactly the case `PageInfoDto` documents: a
   * short page is not the end of the list, and only a null cursor is.
   */
  private applyFilters(
    items: AdjudicationQueueRowDto[],
    operator: OperatorSession,
    query: ListQueueQueryDto,
  ): AdjudicationQueueRowDto[] {
    let result = items;
    if (query.mine) {
      result = result.filter((row) => row.ownerSubject === operator.subject);
    }
    if (query.unassigned) {
      result = result.filter((row) => row.ownerSubject === null);
    }
    if (query.overdue) {
      result = result.filter((row) => row.overdue);
    }
    if (query.rootCauseKey) {
      result = result.filter((row) => row.rootCauseKey === query.rootCauseKey);
    }
    return result;
  }

  async brief(organizationId: string, proposalId: string) {
    const [caseDto, timeline, restoration] = await Promise.all([
      this.cases.buildCase(organizationId, proposalId),
      this.cases.timeline(organizationId, proposalId),
      this.cases.restoration(organizationId, proposalId),
    ]);

    const dispute = caseDto.proposal.disputeId
      ? await this.disputes.findOneBy({ organizationId, id: caseDto.proposal.disputeId })
      : null;

    return {
      case: caseDto,
      dispute,
      timeline,
      restoration,
      requiresSecondSignature: caseDto.proposal.status === SlashProposalStatus.AWAITING_SECOND,
    };
  }

  private async loadDisputes(
    organizationIds: string[],
    disputeIds: string[],
  ): Promise<Map<string, DisputeEntity>> {
    const map = new Map<string, DisputeEntity>();
    if (disputeIds.length === 0) return map;

    // One read per tenant rather than one `IN` across all of them: the scoped
    // repository requires the tenant in the predicate, and reaching around it
    // for a queue that already has every tenant in hand would be spending the
    // guard for nothing.
    const tenants = [...new Set(organizationIds)];
    for (const organizationId of tenants) {
      const rows = await this.disputes.find({
        where: disputeIds.map((id) => ({ organizationId, id })),
      });
      for (const row of rows) map.set(row.id, row);
    }
    return map;
  }

  private async loadProviderNames(
    keys: { org: string; id: string }[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const key of keys) {
      if (map.has(key.id)) continue;
      const provider = await this.providers.findOneBy({
        organizationId: key.org,
        id: key.id,
      });
      if (provider) map.set(key.id, provider.legalName);
    }
    return map;
  }
}

/**
 * The queue's ordering, and the requirement rather than a default.
 *
 * Time-to-deadline, then penalty size — *"not FIFO"*. FIFO
 * against a hard deadline guarantees the oldest case expires first, and under
 * the platform-miss rule an expired case is overturned against us. Insertion
 * order is not a neutral choice here; it is a choice to lose the cases we have
 * held longest.
 *
 * Only the deadline is exposed as sortable. Penalty size is the *tiebreak*, and
 * it is applied by the partial index rather than offered as an alternative
 * ordering, because a client that could sort this list by penalty descending
 * would be able to work the expensive cases first and let the cheap ones time
 * out — which is the failure mode the ordering exists to prevent, reachable
 * through a query parameter.
 */
const QUEUE_LIST: ListSpec = {
  alias: 'proposal',
  defaultSort: 'platformDecisionDueAt',
  sortable: {
    platformDecisionDueAt: {
      column: 'proposal.platform_decision_due_at',
      type: 'timestamptz',
      valueOf: asInstant((row: SlashProposalEntity) => row.platformDecisionDueAt as Date),
    },
  },
  timeColumn: 'proposal.proposed_at',
};
