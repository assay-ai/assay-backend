import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ProviderStakeGraceEntity } from '../entities/provider-stake-grace.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/**
 * `provider_stake_grace`.
 *
 * Organization-scoped throughout, with no cross-tenant read of the kind
 * `ToolBindingRepository.findByTool` needs. A grace period belongs to the
 * provider whose stake fell short: they read their own countdown, the monitor
 * job that opens and resolves rows works one organization at a time, and the
 * router's question — *is this binding inside an open grace period* — is asked
 * about a binding whose owning organization the candidate already carries.
 * Nothing about one provider's shortfall is another tenant's business.
 *
 * No query methods yet, deliberately. The two callers that will need them —
 * `applyStakeGrace` and the monitor job — do not exist yet, and a finder
 * written before its caller is a finder written against a guessed access
 * pattern. The inherited scoped methods cover everything that exists today.
 */
@Injectable()
export class ProviderStakeGraceRepository extends OrganizationScopedRepository<ProviderStakeGraceEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ProviderStakeGraceEntity, dataSource);
  }
}
