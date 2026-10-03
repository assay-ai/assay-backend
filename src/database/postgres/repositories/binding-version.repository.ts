import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { BindingVersionEntity } from '../entities/binding-version.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/**
 * `binding_versions` — the immutable revision log.
 *
 * No cross-tenant read. A revision is only ever looked up by the provider who
 * wrote it or by a dispute that already knows the binding, and both arrive
 * with an organization in hand — so unlike `ToolBindingRepository` this class
 * has nothing to exempt from the scope guard.
 */
@Injectable()
export class BindingVersionRepository extends OrganizationScopedRepository<BindingVersionEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(BindingVersionEntity, dataSource);
  }
}
