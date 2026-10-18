import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ProviderEntity } from '../entities/provider.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** The registration record. One row per organization, enforced by a unique index. */
@Injectable()
export class ProviderRepository extends OrganizationScopedRepository<ProviderEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ProviderEntity, dataSource);
  }

  /**
   * Every provider, regardless of organization.
   *
   * Deliberately cross-organization, the same `organizationId IS NOT NULL`
   * idiom `ProviderTrafficService` and its siblings use for their own
   * reports: the hourly payout batch has to consider every registered
   * provider once per run, not one organization's providers at a time —
   * there is no caller with a single tenant in mind here, unlike every other
   * method on this class.
   */
  async findAllProviders(): Promise<ProviderEntity[]> {
    return this.createQueryBuilder('provider')
      .where('provider.organizationId IS NOT NULL')
      .getMany();
  }

  /**
   * Provider id (`organization_id`) → its display name (`legal_name`), for the
   * ids given — a buyer's refused call names the providers its rules dropped.
   *
   * Cross-organization by nature: the providers are other tenants, and the
   * projection is the public name the catalogue already shows and nothing
   * else. Suspended and exited providers keep their row, so a name survives a
   * delisting.
   */
  async findDisplayNames(providerIds: readonly string[]): Promise<Map<string, string>> {
    if (providerIds.length === 0) return new Map();
    const rows = await this.createQueryBuilder('provider')
      .select(['provider.organizationId', 'provider.legalName'])
      .where('provider.organizationId IN (:...providerIds)', { providerIds: [...providerIds] })
      .getMany();
    return new Map(rows.map((row) => [row.organizationId, row.legalName]));
  }
}
