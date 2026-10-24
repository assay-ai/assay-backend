import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { SlashProposalPartEntity } from '../entities/slash-proposal-part.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** `slash_proposal_parts` — see the entity. */
@Injectable()
export class SlashProposalPartRepository extends OrganizationScopedRepository<SlashProposalPartEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(SlashProposalPartEntity, dataSource);
  }

  /**
   * The parts of this organization's cases whose on-chain request id is one of
   * `chainRequestIds` (lower-case hex, no `0x`). Every epoch's rows, because a
   * record an earlier epoch proposed can still be standing on chain.
   */
  async findOwnByChainRequestIds(
    organizationId: string,
    chainRequestIds: readonly string[],
  ): Promise<Pick<SlashProposalPartEntity, 'id' | 'proposalId' | 'chainRequestId'>[]> {
    if (chainRequestIds.length === 0) return [];
    return this.find({
      select: { id: true, proposalId: true, chainRequestId: true },
      where: { organizationId, chainRequestId: In([...chainRequestIds]) },
    });
  }

  /**
   * The part behind one on-chain request id, across every tenant — for the
   * chain watcher, which reads `SlashDisputed` / `SlashUpheld` and has no
   * tenant. The id is unique (`uq_slash_proposal_parts_request`).
   *
   * Through the entity manager, like {@link findByChainRequestIds}: the scoped
   * `findOne` refuses a read with no `organizationId`, which made every
   * `SlashDisputed` / `SlashUpheld` mirror throw.
   */
  async findOneByChainRequestId(chainRequestId: string): Promise<SlashProposalPartEntity | null> {
    return this.manager
      .createQueryBuilder(SlashProposalPartEntity, 'part')
      .where('part.chain_request_id = :chainRequestId', { chainRequestId })
      .getOne();
  }

  /**
   * Every part whose record stands `DISPUTED` on chain (D-19), oldest dispute
   * first, across tenants — the arbiter's queue. Each row says which case it
   * belongs to and when the 30-day timeout ends it.
   */
  async findChainDisputed(limit: number): Promise<
    {
      requestId: string;
      proposalId: string;
      organizationId: string;
      providerId: string;
      assetId: string;
      caseStatus: string;
      caseChainStatus: string;
      penaltyAmount: string;
      chainReserved: string | null;
      chainDisputedAt: Date | null;
      chainExecutableAt: Date | null;
      agentAccount: string;
      beneficiaryAccount: string;
      windowId: string | null;
      casePenaltyAmount: string;
    }[]
  > {
    return this.manager
      .createQueryBuilder(SlashProposalPartEntity, 'part')
      .innerJoin('slash_proposals', 'proposal', 'proposal.id = part.proposal_id')
      .select('part.chain_request_id', 'requestId')
      .addSelect('part.proposal_id', 'proposalId')
      .addSelect('part.organization_id', 'organizationId')
      .addSelect('proposal.provider_id', 'providerId')
      .addSelect('proposal.asset_id', 'assetId')
      .addSelect('proposal.status', 'caseStatus')
      .addSelect('proposal.chain_status', 'caseChainStatus')
      .addSelect('part.penalty_amount', 'penaltyAmount')
      .addSelect('part.chain_reserved', 'chainReserved')
      .addSelect('part.chain_disputed_at', 'chainDisputedAt')
      .addSelect('part.chain_executable_at', 'chainExecutableAt')
      .addSelect('part.agent_account', 'agentAccount')
      .addSelect('part.beneficiary_account', 'beneficiaryAccount')
      .addSelect('proposal.window_id', 'windowId')
      .addSelect('proposal.penalty_amount', 'casePenaltyAmount')
      .where(`part.chain_status = 'DISPUTED'`)
      .orderBy('part.chain_disputed_at', 'ASC')
      .limit(limit)
      .getRawMany();
  }

  /**
   * Review R2-6: records of an EARLIER epoch of their case that landed on
   * chain late and still stand (`PENDING` or `DISPUTED`), marked
   * `SupersededEpoch` by the watcher. They cover the same calls as the
   * current epoch's records, so the arbiter is asked to cancel each; nothing
   * of this platform executes them. Across tenants, soonest door first.
   */
  async findSupersededStanding(limit: number): Promise<
    {
      requestId: string;
      proposalId: string;
      organizationId: string;
      providerId: string;
      assetId: string;
      chainStatus: string;
      chainEpoch: number;
      caseChainEpoch: number;
      penaltyAmount: string;
      chainReserved: string | null;
      chainExecutableAt: Date | null;
    }[]
  > {
    return this.manager
      .createQueryBuilder(SlashProposalPartEntity, 'part')
      .innerJoin('slash_proposals', 'proposal', 'proposal.id = part.proposal_id')
      .select('part.chain_request_id', 'requestId')
      .addSelect('part.proposal_id', 'proposalId')
      .addSelect('part.organization_id', 'organizationId')
      .addSelect('proposal.provider_id', 'providerId')
      .addSelect('proposal.asset_id', 'assetId')
      .addSelect('part.chain_status', 'chainStatus')
      .addSelect('part.chain_epoch', 'chainEpoch')
      .addSelect('proposal.chain_epoch', 'caseChainEpoch')
      .addSelect('part.penalty_amount', 'penaltyAmount')
      .addSelect('part.chain_reserved', 'chainReserved')
      .addSelect('part.chain_executable_at', 'chainExecutableAt')
      .where("part.chain_last_error = 'SupersededEpoch'")
      .andWhere("part.chain_status IN ('PENDING', 'DISPUTED')")
      .andWhere('part.chain_epoch < proposal.chain_epoch')
      .orderBy('part.chain_executable_at', 'ASC')
      .limit(limit)
      .getRawMany();
  }

  /**
   * Every on-chain slash record this platform has standing (`PENDING` or
   * `DISPUTED`), across tenants, with its asset: the current epoch's parts of
   * partitioned cases and the single records of the others. For the
   * verifier-key expiry monitor (follow-up B5), which reads each record's
   * verifier from the chain. One page, soonest `chain_executable_at` first
   * (review S-7): the caller pages with `offset` until a short page.
   */
  async findOpenChainRecords(
    limit: number,
    offset = 0,
  ): Promise<{ requestId: string; assetId: string }[]> {
    return (await this.manager.query(
      `SELECT request_id AS "requestId", asset_id AS "assetId" FROM (
         SELECT part.chain_request_id AS request_id, proposal.asset_id,
                part.chain_executable_at AS executable_at
           FROM slash_proposal_parts part
           JOIN slash_proposals proposal
             ON proposal.id = part.proposal_id AND proposal.chain_epoch = part.chain_epoch
          WHERE part.chain_status IN ('PENDING', 'DISPUTED')
         UNION
         SELECT proposal.chain_request_id, proposal.asset_id, proposal.chain_executable_at
           FROM slash_proposals proposal
          WHERE proposal.window_id IS NULL
            AND proposal.chain_status IN ('PENDING', 'DISPUTED', 'CANCEL_REQUESTED')
       ) open_records
       WHERE asset_id LIKE 'eip155:%'
       ORDER BY executable_at ASC NULLS LAST, request_id ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    )) as { requestId: string; assetId: string }[];
  }

  /**
   * What this platform's parts hold of one provider's rolling slash WINDOW
   * on one chain, split in two, minor units (review 2026-10-24 F-M1, then
   * review 2026-10-24 wave 2 M-1). The window is metered as the chain meters
   * it: only executions consume it (`executeSlash`), never a standing record.
   *
   * - `pendingDue`: the reservation (else the penalty) of every part still
   *   `PENDING` whose door opens at or before `dueBy` (or whose door is not
   *   known yet) — what will compete with a new part for the window.
   *   `DISPUTED` parts are NOT counted: a disputed record cannot execute
   *   until the arbiter rules, so it holds only the provider's free stake
   *   (which `pendingSlash` already reflects), never its window. Counting it
   *   let one day of records the provider disputes itself block every honest
   *   case for up to 30 days.
   * - `executedSince`: the same figure for parts `EXECUTED` after
   *   `executedSince` (their execution time, else their proposal time) — what
   *   the provider's rolling window has already paid out.
   *
   * Disputed, cancelled (and expired) and refused parts hold nothing here.
   */
  async committedAgainstProvider(
    providerId: string,
    chainId: string,
    executedSince: Date,
    dueBy: Date,
  ): Promise<{ pendingDue: bigint; executedSince: bigint }> {
    const [row] = (await this.manager.query(
      `SELECT
         COALESCE(SUM(COALESCE(part.chain_reserved, part.penalty_amount))
           FILTER (WHERE part.chain_status = 'PENDING'
                     AND (part.chain_executable_at IS NULL OR part.chain_executable_at <= $4)),
           0)::text AS "pendingDue",
         COALESCE(SUM(COALESCE(part.chain_reserved, part.penalty_amount))
           FILTER (WHERE part.chain_status = 'EXECUTED'
                     AND COALESCE(part.executed_at, part.chain_proposed_at) > $3), 0)::text
           AS "executedSince"
         FROM slash_proposal_parts part
         JOIN slash_proposals proposal ON proposal.id = part.proposal_id
        WHERE proposal.provider_id = $1
          AND proposal.asset_id LIKE $2
          AND part.chain_status IN ('PENDING', 'EXECUTED')`,
      [providerId, `${chainId}/%`, executedSince, dueBy],
    )) as { pendingDue: string; executedSince: string }[];
    return {
      pendingDue: BigInt(row?.pendingDue ?? '0'),
      executedSince: BigInt(row?.executedSince ?? '0'),
    };
  }

  /** One case's parts at one epoch, in agent order — the order they were planned in. */
  async findForEpoch(
    organizationId: string,
    proposalId: string,
    chainEpoch: number,
  ): Promise<SlashProposalPartEntity[]> {
    return this.find({
      where: { organizationId, proposalId, chainEpoch },
      order: { agentAccount: 'ASC' },
    });
  }

  /**
   * Persist a plan, **once, whole**.
   *
   * One transaction, one INSERT of every row, and NO `ON CONFLICT DO NOTHING`:
   * a conflict on `uq_slash_proposal_parts_agent` or `…_request` aborts the
   * whole statement, so two planners that raced can never leave a mixture of
   * both plans. The loser then reads the winner's rows back. Whatever is
   * returned is what is signed for — never the caller's in-memory plan — so a
   * re-plan on a retry cannot change a penalty already put on chain.
   */
  async insertPlan(
    organizationId: string,
    proposalId: string,
    chainEpoch: number,
    rows: readonly QueryDeepPartialEntity<SlashProposalPartEntity>[],
  ): Promise<SlashProposalPartEntity[]> {
    if (rows.length > 0) {
      try {
        await this.manager.transaction(async (manager) => {
          await manager
            .createQueryBuilder()
            .insert()
            .into(SlashProposalPartEntity)
            .values(rows.map((row) => ({ ...row, organizationId, proposalId, chainEpoch })))
            .execute();
        });
      } catch (error) {
        if ((error as { code?: string })?.code !== '23505') throw error;
        // Lost the race: the winner's plan stands, whole.
      }
    }
    return this.findForEpoch(organizationId, proposalId, chainEpoch);
  }

  /**
   * Cases (cross-tenant, like the other sweeps) closed as executed while a
   * part of their current epoch is not settled: still PENDING on chain (a
   * reservation an `expireSlash` did not release, or a part not yet paid), or
   * recently REFUSED (a straggler whose transaction may have landed late).
   */
  async findCasesWithStrandedParts(
    limit: number,
  ): Promise<{ organizationId: string; proposalId: string }[]> {
    return (
      this.manager
        .createQueryBuilder(SlashProposalPartEntity, 'part')
        .innerJoin('slash_proposals', 'proposal', 'proposal.id = part.proposal_id')
        .select('part.organization_id', 'organizationId')
        .addSelect('part.proposal_id', 'proposalId')
        // PENDING: a reservation still standing. REFUSED, recently: a straggler
        // given up on while its transaction was in flight. An attestation is
        // valid for 10 minutes, so nothing can land a day after the refusal —
        // older refusals stand and are not re-read for ever.
        .where(
          `(part.chain_status IN ('PENDING', 'DISPUTED')
          OR (part.chain_status = 'REFUSED' AND part.updated_at > now() - interval '1 day'))`,
        )
        .andWhere('part.chain_epoch = proposal.chain_epoch')
        .andWhere(`proposal.status IN ('EXECUTED', 'REVERSED')`)
        .groupBy('part.organization_id')
        .addGroupBy('part.proposal_id')
        .limit(limit)
        .getRawMany()
    );
  }

  /**
   * The stored parts behind these on-chain request ids, across every tenant —
   * for `EvmSlashProposalWatcher`, which reads `SlashProposed` events and has
   * no tenant. `chainRequestIds` are 64 lower-case hex characters, no `0x`.
   */
  async findByChainRequestIds(
    chainRequestIds: readonly string[],
  ): Promise<
    Pick<
      SlashProposalPartEntity,
      | 'organizationId'
      | 'proposalId'
      | 'chainRequestId'
      | 'beneficiaryAccount'
      | 'penaltyAmount'
      | 'chainStatus'
    >[]
  > {
    if (chainRequestIds.length === 0) return [];
    return this.manager
      .createQueryBuilder(SlashProposalPartEntity, 'part')
      .select([
        'part.organizationId',
        'part.proposalId',
        'part.chainRequestId',
        'part.beneficiaryAccount',
        'part.penaltyAmount',
        'part.chainStatus',
      ])
      .where('part.chain_request_id IN (:...ids)', { ids: [...chainRequestIds] })
      .getMany();
  }

  async updatePart(
    organizationId: string,
    id: string,
    patch: QueryDeepPartialEntity<SlashProposalPartEntity>,
  ): Promise<void> {
    await this.update({ organizationId, id }, patch);
  }
}
