import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';

import { DisputeEntity } from '@database/postgres/entities/dispute.entity';
import { DisputeRepository } from '@database/postgres/repositories/dispute.repository';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { SlaWindowRepository } from '@database/postgres/repositories/sla-window.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { CursorPageDto, ListSpec, applyTimeWindow, asInstant, paginate } from '@shared/api';
import { MoneyUtil } from '@shared/utils/money.util';

import { CreateDisputeBodyDto } from '../dto/create-dispute.dto';
import { DISPUTE_RESPONSE_WINDOW_HOURS } from '../constants/dispute.constants';
import {
  DisputeDto,
  DisputeState,
  DisputeSubjectType,
  TERMINAL_DISPUTE_STATES,
} from '../dto/dispute.dto';
import { ListDisputesQueryDto } from '../dto/list-disputes.dto';
import { DisputeErrors } from '../errors/dispute.errors';

/**
 * Declared next to the query it drives, per `backend/docs/api-list-contract.md`.
 * The keyset index is `idx_disputes_feed (organization_id, created_at, id)`,
 * already added by `1756000000000-create-api-surface-tables`.
 */
const DISPUTE_LIST: ListSpec = {
  alias: 'dispute',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'dispute.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: DisputeEntity) => row.createdAt),
    },
  },
};

/**
 * The subject type of a provider's objection to a proposed penalty. It is
 * written by the slash module (`ArbitrationService.fileDispute`) and moved only
 * by the slash case's own lifecycle, so the generic acknowledge and withdraw
 * routes refuse it (review S-10): otherwise the dispute and its case disagree.
 */
const SLASH_PROPOSAL_SUBJECT = 'SLASH_PROPOSAL';

/** The `state` context of a refusal on a slash objection. */
const slashObjectionState = (dispute: DisputeEntity): string =>
  `${dispute.state} (an objection to a proposed penalty, managed on its slash case)`;

/**
 * `GET /disputes`, `GET /disputes/:id`, `POST /disputes`,
 * `POST /disputes/:id/acknowledge`, `POST /disputes/:id/withdraw`.
 *
 * Opening, acknowledging, withdrawing and reading — **not** adjudication.
 * Who reviews a dispute, on what SLA, and how a partial overturn restores
 * stake are not implemented here; `resolvedAt` / `resolvedBy` / `resolutionNote` /
 * `restoredAmount` are columns this service never writes.
 */
@Injectable()
export class DisputeService {
  constructor(
    private readonly disputes: DisputeRepository,
    private readonly paymentIntents: PaymentIntentRepository,
    private readonly verificationRecords: VerificationRecordRepository,
    private readonly slaWindows: SlaWindowRepository,
  ) {}

  async list(
    organizationId: string,
    query: ListDisputesQueryDto,
  ): Promise<CursorPageDto<DisputeDto>> {
    const qb = this.disputes
      .createQueryBuilder('dispute')
      .where('dispute.organizationId = :organizationId', { organizationId });

    applyTimeWindow(qb, query, DISPUTE_LIST);

    if (query.state?.length) {
      qb.andWhere('dispute.state IN (:...states)', { states: query.state });
    }
    if (query.subjectType) {
      qb.andWhere('dispute.subjectType = :subjectType', { subjectType: query.subjectType });
    }
    if (query.claimType) {
      qb.andWhere('dispute.claimType = :claimType', { claimType: query.claimType });
    }
    if (query.providerId) {
      qb.andWhere('dispute.providerId = :providerId', { providerId: query.providerId });
    }

    const page = await paginate(qb, query, DISPUTE_LIST);
    return page.map(toDto);
  }

  async getById(organizationId: string, id: string): Promise<DisputeDto> {
    const dispute = await this.disputes.findOneBy({ organizationId, id });
    if (!dispute) {
      throw DisputeErrors.disputeNotFound({ id });
    }
    return toDto(dispute);
  }

  /**
   * Opens a dispute. Validates the subject exists **either as the caller's
   * own payment (the payer path) or as a call the caller served (the
   * provider path)** first — see {@link assertSubjectExists}. A caller naming
   * a subject that belongs to neither gets exactly the same `404` as one
   * naming an id that does not exist anywhere: distinguishing them would let
   * an attacker enumerate ids by status code alone.
   */
  async create(
    organizationId: string,
    session: McpSession,
    body: CreateDisputeBodyDto,
  ): Promise<DisputeDto> {
    const providerId = await this.assertSubjectExists(
      organizationId,
      body.subjectType,
      body.subjectId,
    );

    const entity = new DisputeEntity();
    entity.organizationId = organizationId;
    entity.subjectType = body.subjectType;
    entity.subjectId = body.subjectId;
    entity.providerId = providerId;
    entity.state = DisputeState.OPEN;
    entity.claimType = body.claimType;
    entity.reason = body.reason;
    entity.evidence = body.evidence ?? [];
    entity.openedBy = session.agentId;
    entity.acknowledgedAt = null;
    entity.deadlineAt = null;
    entity.resolvedAt = null;
    entity.resolvedBy = null;
    entity.resolutionNote = null;
    entity.restoredAmount = null;
    entity.assetId = null;
    entity.decimals = null;

    await this.disputes.save(entity);
    return toDto(entity);
  }

  /**
   * Sets `acknowledgedAt` and derives `deadlineAt` from it — never from
   * `createdAt`. See `DisputeEntity`'s class comment and
   * `chk_disputes_deadline_needs_ack`: the deadline may only exist once
   * acknowledged, and the clock starts here.
   */
  async acknowledge(organizationId: string, id: string): Promise<DisputeDto> {
    const dispute = await this.disputes.findOneBy({ organizationId, id });
    if (!dispute) {
      throw DisputeErrors.disputeNotFound({ id });
    }
    if (dispute.subjectType === SLASH_PROPOSAL_SUBJECT) {
      throw DisputeErrors.notAcknowledgeable({ state: slashObjectionState(dispute) });
    }
    if (TERMINAL_DISPUTE_STATES.includes(dispute.state as DisputeState)) {
      throw DisputeErrors.notAcknowledgeable({ state: dispute.state });
    }
    if (dispute.acknowledgedAt) {
      throw DisputeErrors.alreadyAcknowledged({
        id,
        acknowledgedAt: dispute.acknowledgedAt.toISOString(),
      });
    }

    const acknowledgedAt = new Date();
    const deadlineAt = new Date(
      acknowledgedAt.getTime() + DISPUTE_RESPONSE_WINDOW_HOURS * 60 * 60 * 1000,
    );

    await this.disputes.update({ organizationId, id }, { acknowledgedAt, deadlineAt });

    dispute.acknowledgedAt = acknowledgedAt;
    dispute.deadlineAt = deadlineAt;
    return toDto(dispute);
  }

  async withdraw(organizationId: string, id: string): Promise<DisputeDto> {
    const dispute = await this.disputes.findOneBy({ organizationId, id });
    if (!dispute) {
      throw DisputeErrors.disputeNotFound({ id });
    }
    if (dispute.subjectType === SLASH_PROPOSAL_SUBJECT) {
      throw DisputeErrors.notWithdrawable({ state: slashObjectionState(dispute) });
    }
    if (TERMINAL_DISPUTE_STATES.includes(dispute.state as DisputeState)) {
      throw DisputeErrors.notWithdrawable({ state: dispute.state });
    }

    await this.disputes.update({ organizationId, id }, { state: DisputeState.WITHDRAWN });

    dispute.state = DisputeState.WITHDRAWN;
    return toDto(dispute);
  }

  /**
   * Resolves the subject two ways and returns what `DisputeEntity.providerId`
   * should be stamped with — `null` when the match was on the **payer**
   * path (an agent disputing its own call, unchanged from before this
   * method existed), or the caller's own `organizationId` when the match was
   * on the **provider** path (a provider disputing a call it served).
   *
   * `payment_intents.organization_id` and `verification_records.
   * organization_id` are the **payer's** org — see `OrganizationScopedRepository`'s
   * class comment — so a provider's own subjects never match `{
   * organizationId, id }`. The payer lookup is tried first and, on a hit,
   * short-circuits exactly as this method always has. Only on a miss is the
   * provider lookup tried, and it is **deliberately cross-organization**: the
   * row it is looking for belongs to whichever tenant paid, not to the
   * caller, so `provider_id = organizationId` is the only predicate that can
   * scope it. That satisfies `OrganizationScopedRepository.
   * createQueryBuilder`'s guard with the same `WHERE organizationId IS NOT
   * NULL` tautology `ProviderTrafficService` uses
   * (`src/modules/provider/services/provider-traffic.service.ts` L52-58) —
   * the column is `NOT NULL`, so the tautology proves nothing and scopes
   * nothing; `providerId = organizationId` is what actually scopes the read,
   * relying on `providerId == organizationId` for a provider session (see
   * `provider-verdicts.controller.ts` L60-61).
   *
   * A caller who is neither payer nor provider of the subject gets the same
   * `404` as one naming an id that does not exist anywhere: distinguishing
   * "not yours" from "does not exist" would let ids be enumerated by status
   * code alone.
   *
   * `SLA_WINDOW` needs only the payer-shaped lookup, not the two-step dance
   * above: `sla_windows.organization_id` **is** the provider's own org
   * (`SlaWindowEntity`'s class comment — "a provider *is* an organization on
   * this platform"), an SLA window has no payer side to dispute it from, and
   * the table always exists. A window found this
   * way is always a provider's own, so it always stamps `providerId`.
   */
  private async assertSubjectExists(
    organizationId: string,
    subjectType: DisputeSubjectType,
    subjectId: string,
  ): Promise<string | null> {
    const notFound = () => DisputeErrors.subjectNotFound({ subjectType, subjectId });

    switch (subjectType) {
      case DisputeSubjectType.PAYMENT_INTENT: {
        if (!isUUID(subjectId)) throw notFound();
        const asPayer = await this.paymentIntents.findOneBy({ organizationId, id: subjectId });
        if (asPayer) return null;
        const asProvider = await this.paymentIntents
          .createQueryBuilder('intent')
          .where('intent.organizationId IS NOT NULL')
          .andWhere('intent.id = :id', { id: subjectId })
          .andWhere('intent.providerId = :providerId', { providerId: organizationId })
          .getOne();
        if (!asProvider) throw notFound();
        return organizationId;
      }
      case DisputeSubjectType.VERDICT: {
        if (!isUUID(subjectId)) throw notFound();
        const asPayer = await this.verificationRecords.findOneBy({
          organizationId,
          id: subjectId,
        });
        if (asPayer) return null;
        const asProvider = await this.verificationRecords
          .createQueryBuilder('record')
          .where('record.organizationId IS NOT NULL')
          .andWhere('record.id = :id', { id: subjectId })
          .andWhere('record.providerId = :providerId', { providerId: organizationId })
          .getOne();
        if (!asProvider) throw notFound();
        return organizationId;
      }
      case DisputeSubjectType.SLA_WINDOW: {
        if (!isUUID(subjectId)) throw notFound();
        const window = await this.slaWindows.findOneBy({ organizationId, id: subjectId });
        if (!window) throw notFound();
        return organizationId;
      }
    }
  }
}

function toDto(row: DisputeEntity): DisputeDto {
  return {
    id: row.id,
    subjectType: row.subjectType as DisputeSubjectType,
    subjectId: row.subjectId,
    providerId: row.providerId,
    state: row.state as DisputeState,
    claimType: row.claimType,
    reason: row.reason,
    evidence: row.evidence,
    openedBy: row.openedBy,
    acknowledgedAt: row.acknowledgedAt,
    deadlineAt: row.deadlineAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    resolutionNote: row.resolutionNote,
    restoredAmount: toRestoredAmountDto(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRestoredAmountDto(row: DisputeEntity): MoneyDto | null {
  if (row.restoredAmount == null || row.assetId == null || row.decimals == null) return null;
  const money = MoneyUtil.of(row.restoredAmount, row.assetId as AssetId, row.decimals);
  return { amount: money.amount, asset: money.asset, decimals: money.decimals };
}
