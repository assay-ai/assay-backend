import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ReconciliationRunEntity } from '../entities/reconciliation-run.entity';
import { AbstractRepository } from './abstract.repository';

/**
 * The reconciliation history.
 *
 * `AbstractRepository`, not `OrganizationScopedRepository` — see the entity
 * for why this table belongs to no organization. It is one of three such
 * tables in the schema and the exception is deliberate, not a missed
 * conversion.
 */
@Injectable()
export class ReconciliationRunRepository extends AbstractRepository<ReconciliationRunEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ReconciliationRunEntity, dataSource);
  }

  /** The most recent run for an asset, or `null` if the reconciler has never run. */
  async findLatest(assetId: string): Promise<ReconciliationRunEntity | null> {
    return this.findOne({ where: { assetId }, order: { startedAt: 'DESC' } });
  }

  /**
   * The most recent `limit` runs, newest first.
   *
   * Used to decide whether a *sequence* of failures has become serious: one
   * chain read that times out is a blip, three in a row is fifteen minutes
   * during which nobody was checking the money.
   */
  async findRecent(assetId: string, limit: number): Promise<ReconciliationRunEntity[]> {
    return this.find({ where: { assetId }, order: { startedAt: 'DESC' }, take: limit });
  }

  /**
   * The latest run for **every** asset the reconciler has ever touched, one
   * row per `assetId` — added for the "reconciler drift" metric.
   *
   * `findLatest` needs an asset id up front; a platform-wide gauge does not
   * have one to pass in (the MVP vault holds only USDC today, but a metric
   * that hard-codes that would silently go blind on the day a second asset is
   * onboarded — see `ReconciliationRunEntity`'s own docstring on why this
   * table is not organization-scoped, for the same "no fixed enumeration"
   * reasoning). `DISTINCT ON` is the one-query way to get "latest per group"
   * without a self-join or an N+1 over `findLatest`.
   */
  async findLatestPerAsset(): Promise<ReconciliationRunEntity[]> {
    return this.createQueryBuilder('run')
      .distinctOn(['run.asset_id'])
      .orderBy('run.asset_id', 'ASC')
      .addOrderBy('run.started_at', 'DESC')
      .getMany();
  }
}
