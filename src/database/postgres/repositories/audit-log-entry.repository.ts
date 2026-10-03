import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuditLogEntryEntity } from '../entities/audit-log-entry.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/**
 * The audit trail.
 *
 * Read and append only. There is deliberately no update or delete helper here:
 * an audit log with a convenient mutator grows one, and then it is no longer
 * evidence of anything. The inherited `update`/`delete` remain reachable
 * through the base class, but nothing in the surface calls them.
 */
@Injectable()
export class AuditLogEntryRepository extends OrganizationScopedRepository<AuditLogEntryEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(AuditLogEntryEntity, dataSource);
  }
}
