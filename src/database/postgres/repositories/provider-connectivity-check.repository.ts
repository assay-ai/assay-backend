import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ProviderConnectivityCheckEntity } from '../entities/provider-connectivity-check.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** Endpoint probes at registration. Kept for the argument afterwards. */
@Injectable()
export class ProviderConnectivityCheckRepository extends OrganizationScopedRepository<ProviderConnectivityCheckEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ProviderConnectivityCheckEntity, dataSource);
  }
}
