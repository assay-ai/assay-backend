import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Not } from 'typeorm';

import { ProviderChainEnrolmentEntity } from '../entities/provider-chain-enrolment.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/**
 * `provider_chain_enrolments`. One provider identity, N chain enrolments —
 * see the entity for what lives here and what stays on `providers`.
 */
@Injectable()
export class ProviderChainEnrolmentRepository extends OrganizationScopedRepository<ProviderChainEnrolmentEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ProviderChainEnrolmentEntity, dataSource);
  }

  /**
   * Every enrolment for these providers, in one statement.
   *
   * Batched for the reason `ProviderStakePort.stakeOn` is batched: routing
   * scores every candidate binding for a tool at once, and a per-provider call
   * would put N sequential round-trips on the path an agent is blocked on.
   * Served by `idx_provider_chain_enrolments_organization_id`.
   *
   * Cross-*provider* but not cross-tenant, and the distinction matters. The
   * candidate set names every organization it is about, so the predicate is an
   * ordinary `organizationId IN (…)` and stays inside the scope guard — the
   * same shape `DbStakeGraceSource` uses, and deliberately not the unscoped
   * `IS NOT NULL` idiom that `ToolBindingRepository.findByTool` needs and that
   * `test/unit/shared/api/surface-consistency.spec.ts` allowlists file by
   * file. Nothing here needs that exemption.
   *
   * The empty-list early return is not an optimisation: `In([])` compiles to a
   * predicate Postgres can only answer with "no rows", and the scope guard
   * would let it through because the column *is* named. Returning here keeps
   * the statement off the wire and keeps the source's own contract — a lookup
   * for nobody asks nobody — provable at this layer too.
   */
  async findByProviders(providerIds: readonly string[]): Promise<ProviderChainEnrolmentEntity[]> {
    if (providerIds.length === 0) return [];
    return this.find({ where: { organizationId: In([...providerIds]) } });
  }

  /**
   * Every chain this provider has proved a stake authority on.
   *
   * Exists so that the two callers with no chain in hand — the stake intents
   * and the slash executor's compensation routes — can ask *how many* rather
   * than take a first row. Both refuse when the answer is more than one: the
   * bytes they build are signed against one chain's `ProviderStake` PDA, and
   * "the first enrolment" is a coin toss on which account a wallet is asked to
   * move money out of.
   *
   * Ordered by chain id so the refusal message is stable, which matters because
   * it names the chains and a support ticket quotes it.
   */
  async findProvedStakeAuthorities(
    organizationId: string,
  ): Promise<ProviderChainEnrolmentEntity[]> {
    return this.find({
      where: { organizationId, stakeAuthorityAccountId: Not(IsNull()) },
      order: { chainId: 'ASC' },
    });
  }
}
