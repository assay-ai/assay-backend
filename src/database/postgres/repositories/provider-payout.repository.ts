import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

import { ProviderPayoutEntity } from '../entities/provider-payout.entity';
import { assertOrganizationScopedValues } from '../organization-scope';
import { OrganizationScopedRepository } from './organization-scoped.repository';

export type ProviderPayoutStatus = 'PENDING' | 'SUBMITTED' | 'RECORDED';

/**
 * The durable payout run record. See `ProviderPayoutEntity` for the shape and
 * the reasoning; this class is the narrow set of reads and writes the deleted
 * payout batch actually needed. Read-only now — see `ProviderPayoutEntity`.
 */
@Injectable()
export class ProviderPayoutRepository extends OrganizationScopedRepository<ProviderPayoutEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ProviderPayoutEntity, dataSource);
  }

  /**
   * Reserves the period. Runs inside the caller's transaction, alongside the
   * balance-row lock that computed `amount`/`fromSeq`/`toSeq`, so "the period
   * is claimed" and "the snapshot behind it" commit or roll back together.
   *
   * Distinguishes the unique-index collision from every other insert failure
   * by constraint name — a re-run of the same hourly period is expected and
   * quiet; anything else is not.
   */
  async insertPending(
    row: {
      readonly organizationId: string;
      readonly assetId: string;
      readonly decimals: number;
      readonly periodStart: Date;
      readonly periodEnd: Date;
      readonly amount: string;
      readonly fromSeq: string;
      readonly toSeq: string;
      readonly callCount: number;
      readonly batchId: string;
      readonly sourceAccountId: string;
      readonly payoutAccountId: string;
    },
    queryRunner: QueryRunner,
  ): Promise<ProviderPayoutEntity> {
    assertOrganizationScopedValues([row], 'ProviderPayoutEntity.insertPending');

    const result = await queryRunner.manager
      .createQueryBuilder()
      .insert()
      .into(ProviderPayoutEntity)
      .values({ ...row, status: 'PENDING', chainTxRef: null, ledgerEntryId: null })
      .execute();

    return queryRunner.manager.findOneByOrFail(ProviderPayoutEntity, {
      id: result.identifiers[0].id as string,
    });
  }

  /** The most recent payout for this provider+asset, whatever its status — the next `fromSeq`. */
  async findLatest(organizationId: string, assetId: string): Promise<ProviderPayoutEntity | null> {
    const rows = await this.createQueryBuilder('payout')
      .where('payout.organizationId = :organizationId', { organizationId })
      .andWhere('payout.assetId = :assetId', { assetId })
      .orderBy('payout.periodStart', 'DESC')
      .limit(1)
      .getMany();
    return rows[0] ?? null;
  }

  async findByPeriod(
    organizationId: string,
    assetId: string,
    periodStart: Date,
  ): Promise<ProviderPayoutEntity | null> {
    return this.findOneBy({ organizationId, assetId, periodStart });
  }

  /**
   * Every row not yet `RECORDED`, across **every** organization.
   *
   * Deliberately cross-organization, the same idiom `ProviderTrafficService`
   * and its siblings use for their own reports: this runs once per scheduler
   * pass, not once per tenant, so a resumed run after a crash finds every
   * provider's unfinished payout in one query rather than one per provider.
   */
  async findResumable(): Promise<ProviderPayoutEntity[]> {
    return this.createQueryBuilder('payout')
      .where('payout.organizationId IS NOT NULL')
      .andWhere('payout.status != :recorded', { recorded: 'RECORDED' })
      .orderBy('payout.createdAt', 'ASC')
      .getMany();
  }

  /** `PENDING → SUBMITTED`: the inert on-chain instruction was built. Sets `chainTxRef`. */
  async markSubmitted(organizationId: string, id: string, chainTxRef: string): Promise<void> {
    await this.update({ organizationId, id }, { status: 'SUBMITTED', chainTxRef });
  }

  /** `SUBMITTED → RECORDED`: the `PAYOUT` ledger entry was written. Sets `ledgerEntryId`. */
  async markRecorded(organizationId: string, id: string, ledgerEntryId: string): Promise<void> {
    await this.update({ organizationId, id }, { status: 'RECORDED', ledgerEntryId });
  }
}
