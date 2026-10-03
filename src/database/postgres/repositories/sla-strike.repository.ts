import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SlaStrikeEntity } from '../entities/sla-strike.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/**
 * `sla_strikes`.
 *
 * No query methods yet, deliberately — same reasoning as
 * `ProviderStakeGraceRepository`. `SlaWindowService.closeWindow` writes through
 * the inherited `insert()`, catching `uq_sla_strikes_window` as its idempotency
 * backstop, and nothing here reads a strike back: the slash proposal surface
 * this table feeds lives elsewhere, and a finder written before that caller
 * exists is a finder written against a guessed access pattern.
 */
@Injectable()
export class SlaStrikeRepository extends OrganizationScopedRepository<SlaStrikeEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(SlaStrikeEntity, dataSource);
  }
}
