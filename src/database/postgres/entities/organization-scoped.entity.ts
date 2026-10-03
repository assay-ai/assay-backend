import { Column, Index } from 'typeorm';
import { AbstractEntity, AbstractEntityWithoutSoftDelete } from './abstract.entity';
import { ORGANIZATION_SCOPE_COLUMN } from '../organization-scope/organization-scope.constants';

/**
 * Base class for every business table.
 *
 * `organizationId` is required on **every** table. Doing it once twenty tables
 * exist is a system-wide migration plus a rewrite of every query written in
 * between, so it lands before the first business table does.
 *
 * The index is declared here rather than per entity for the same reason the
 * column is: an index a developer must remember to add is one that will
 * eventually be missing on the single table where the sequential scan hurts.
 * TypeORM names it `IDX_<hash>` per table — the one documented exception to the
 * `idx_{table}_{column}` convention in `docs/architecture.md`.
 *
 * Entities extending this class MUST be read and written through
 * `OrganizationScopedRepository`. The column marks the boundary; the repository
 * is what enforces it.
 */
export abstract class OrganizationScopedEntity extends AbstractEntity {
  @Index()
  @Column({ name: ORGANIZATION_SCOPE_COLUMN, type: 'uuid' })
  organizationId: string;
}

/**
 * The same boundary for tables that must never be soft-deleted — the financial
 * record: "a deleted payment record is a reconciliation hole".
 */
export abstract class OrganizationScopedEntityWithoutSoftDelete extends AbstractEntityWithoutSoftDelete {
  @Index()
  @Column({ name: ORGANIZATION_SCOPE_COLUMN, type: 'uuid' })
  organizationId: string;
}
