import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { OrganizationEntity } from '../entities/organization.entity';
import { AbstractRepository } from './abstract.repository';

/**
 * The tenant directory.
 *
 * `AbstractRepository`, not `OrganizationScopedRepository` — a repository that
 * refused to answer without an `organizationId` cannot serve the table that
 * *defines* organization ids. The scope guard protects rows *belonging to* a
 * tenant; this table is the tenant.
 *
 * Thin on purpose: the only writer is `AgentRepository.createWithOrganization`
 * (one transaction, so the row cannot exist without the agent that caused it),
 * and the only reader is the session source.
 */
@Injectable()
export class OrganizationRepository extends AbstractRepository<OrganizationEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(OrganizationEntity, dataSource);
  }

  findById(id: string): Promise<OrganizationEntity | null> {
    return this.findOne({ where: { id } });
  }
}
