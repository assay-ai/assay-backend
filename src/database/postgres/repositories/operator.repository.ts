import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { OperatorEntity } from '../entities/operator.entity';
import { AbstractRepository } from './abstract.repository';

/**
 * The internal identity directory.
 *
 * `AbstractRepository`, not `OrganizationScopedRepository` — an operator
 * belongs to the platform, not to a tenant. See the entity's docstring and
 * the migration header (`1757700000000-...`) for why: giving this row an
 * `organizationId` would either invent a fake "platform" tenant that then
 * appears in every tenant-scoped aggregate, or imply that an adjudicator
 * belongs to the provider they are judging.
 *
 * Thin on purpose: only the finders its actual callers need.
 */
@Injectable()
export class OperatorRepository extends AbstractRepository<OperatorEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(OperatorEntity, dataSource);
  }

  /**
   * The row for a subject, whatever its `status`.
   *
   * Named for what it answers — "who is the operator behind this subject,
   * right now" — not for a status filter: `subject` is unique, so there is
   * only ever one current record to find. `ConfigOperatorSessionSource` is
   * the one caller, and it reads `status` itself so it can throw
   * `OPERATOR_SUSPENDED` rather than the same `OPERATOR_CREDENTIAL_INVALID`
   * it throws for a subject that was never provisioned — a filtered finder
   * would erase that distinction before the caller ever saw it.
   */
  findActiveBySubject(subject: string): Promise<OperatorEntity | null> {
    return this.findOne({ where: { subject } });
  }

  findById(id: string): Promise<OperatorEntity | null> {
    return this.findOne({ where: { id } });
  }

  /** The register's own `Owner` picker and the console's operator list. Small table, no paging. */
  listAll(): Promise<OperatorEntity[]> {
    return this.find({ order: { displayName: 'ASC' } });
  }
}
