import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { DisputeEntity } from '../entities/dispute.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** Challenges to a verdict or an SLA window. */
@Injectable()
export class DisputeRepository extends OrganizationScopedRepository<DisputeEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(DisputeEntity, dataSource);
  }
}
