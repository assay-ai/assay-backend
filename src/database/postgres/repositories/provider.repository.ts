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

  /**
   * Providers that have not yet proved a stake authority.
   *
   * **This is the gate on the stake cutover, and it is why the method exists at
   * all.** `PROVIDER_STAKE_SOURCE_MODE` may be promoted from
   * `chain_with_config_fallback` to `chain` only once this comes back empty:
   * every row it returns is a provider whose stake the chain cannot be asked
   * about, and who would therefore drop to `STAKE_UNKNOWN` and out of paid
   * routing the moment the fallback is removed. A promotion criterion nobody
   * can evaluate is not a criterion, so the question has to be answerable
   * before the decision is due — not discovered from a support ticket
   * afterwards.
   *
   * Cross-organization for the same reason `findAllProviders` above is: the
   * caller is an operator deciding one thing about the whole deployment, not a
   * tenant asking about themselves. Same `organizationId IS NOT NULL` idiom,
   * and this file is already on the allowlist that
   * `test/unit/shared/api/surface-consistency.spec.ts` maintains for exactly
   * these reads.
   *
   * Ordered by registration date so the output reads as a queue — the oldest
   * registrations are the ones that have had the longest to sign and are the
   * likeliest to have stopped watching for the request.
   */
  async findProvidersWithoutStakeAuthority(): Promise<ProviderEntity[]> {
    return (
      this.createQueryBuilder('provider')
        .where('provider.organizationId IS NOT NULL')
        // The stake authority is a column on the ENROLMENT, one per chain.
        // "Has not proved one" is therefore "has no enrolment carrying one" — a provider proved
        // on Solana and not on `eip155:4663` is NOT in this list, and that is
        // correct for what the list is for: the promotion criterion is about a
        // provider the chain source cannot answer for **at all**, and that
        // provider still has one chain it can be served on. Per-chain readiness
        // is a different question and belongs to whoever enables a second chain.
        .andWhere(
          `NOT EXISTS (
           SELECT 1 FROM provider_chain_enrolments e
           WHERE e.organization_id = provider.organization_id
             AND e.stake_authority_account_id IS NOT NULL
         )`,
        )
        .orderBy('provider.createdAt', 'ASC')
        .getMany()
    );
  }
}
