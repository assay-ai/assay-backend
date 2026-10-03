import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ProviderPayoutChallengeEntity } from '../entities/provider-payout-challenge.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** Payout-address proof nonces. Single-use; see the entity. */
@Injectable()
export class ProviderPayoutChallengeRepository extends OrganizationScopedRepository<ProviderPayoutChallengeEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ProviderPayoutChallengeEntity, dataSource);
  }
}
