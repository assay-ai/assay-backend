import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

import { SlashProposalEventEntity } from '../entities/slash-proposal-event.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/**
 * The case timeline the dispute screen renders.
 *
 * Organization-scoped in the ordinary way: a timeline belongs to one provider's
 * case, and the operator reading it across tenants goes through the proposal
 * repository's deliberate cross-tenant queue and then reads one case at a time
 * with its tenant in hand.
 */
@Injectable()
export class SlashProposalEventRepository extends OrganizationScopedRepository<SlashProposalEventEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(SlashProposalEventEntity, dataSource);
  }

  /**
   * Append a timeline row, optionally inside the caller's transaction.
   *
   * Optional, unlike `OverrideLogEntryRepository.append`, and the asymmetry is
   * deliberate. An override entry that commits without its mutation would be a
   * record of something that did not happen; a timeline row is a *rendering*,
   * and one that lands without its cause is a display bug. Requiring a
   * transaction for both would suggest they carry the same weight.
   */
  async append(entry: Partial<SlashProposalEventEntity>, queryRunner?: QueryRunner): Promise<void> {
    if (queryRunner) {
      const row = queryRunner.manager.create(SlashProposalEventEntity, entry);
      await queryRunner.manager.save(SlashProposalEventEntity, row);
      return;
    }
    await this.insert(entry as SlashProposalEventEntity);
  }

  async findForProposal(
    organizationId: string,
    proposalId: string,
  ): Promise<SlashProposalEventEntity[]> {
    return this.find({
      where: { organizationId, proposalId },
      order: { occurredAt: 'ASC', createdAt: 'ASC' },
    });
  }
}
