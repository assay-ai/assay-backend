import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { SlashProposalPartEntity } from '../entities/slash-proposal-part.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** `slash_proposal_parts` — see the entity. */
@Injectable()
export class SlashProposalPartRepository extends OrganizationScopedRepository<SlashProposalPartEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(SlashProposalPartEntity, dataSource);
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
   * Cases (cross-tenant, like the other sweeps) that are closed as executed
   * while a part of their current epoch still stands PENDING on chain — a
   * reservation an `expireSlash` did not release.
   */
  async findCasesWithStrandedParts(
    limit: number,
  ): Promise<{ organizationId: string; proposalId: string }[]> {
    return this.manager
      .createQueryBuilder(SlashProposalPartEntity, 'part')
      .innerJoin('slash_proposals', 'proposal', 'proposal.id = part.proposal_id')
      .select('part.organization_id', 'organizationId')
      .addSelect('part.proposal_id', 'proposalId')
      .where(`part.chain_status = 'PENDING'`)
      .andWhere('part.chain_epoch = proposal.chain_epoch')
      .andWhere(`proposal.status IN ('EXECUTED', 'REVERSED')`)
      .groupBy('part.organization_id')
      .addGroupBy('part.proposal_id')
      .limit(limit)
      .getRawMany();
  }

  async updatePart(
    organizationId: string,
    id: string,
    patch: QueryDeepPartialEntity<SlashProposalPartEntity>,
  ): Promise<void> {
    await this.update({ organizationId, id }, patch);
  }
}
