import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { StakeSnapshotEntity } from '../entities/stake-snapshot.entity';
import { AbstractRepository } from './abstract.repository';

/**
 * Fleet-wide bonded stake, one row per sweep.
 *
 * `AbstractRepository`, not `OrganizationScopedRepository` — see the entity for
 * why this table belongs to no organization. It is the third such table in the
 * schema and the exception is deliberate, not a missed conversion.
 */
@Injectable()
export class StakeSnapshotRepository extends AbstractRepository<StakeSnapshotEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(StakeSnapshotEntity, dataSource);
  }

  /**
   * Append one reading.
   *
   * There is no update path and there never should be: a snapshot is a claim
   * about a moment that a public page may already have shown.
   */
  async insertSnapshot(input: {
    readonly readAt: Date;
    readonly stakeAsset: string;
    readonly decimals: number;
    readonly bondedTotal: string;
    readonly providerCount: number;
  }): Promise<void> {
    await this.insert({
      readAt: input.readAt,
      stakeAsset: input.stakeAsset,
      decimals: input.decimals,
      bondedTotal: input.bondedTotal,
      providerCount: input.providerCount,
    });
  }

  /**
   * The newest reading, or `null` when the sweep has never produced one.
   *
   * `null` is a real and expected answer, not an error: the sweep skips the
   * snapshot whenever the chain read fails, so a fresh deployment — or one
   * whose RPC has been down since boot — genuinely has nothing to show. The
   * page must render that as "not yet read" rather than as a zero, because a
   * zero would claim the fleet has no stake.
   *
   * Ordered by `readAt`, not `createdAt`: the question is which reading is
   * most recent about the chain, not which row reached Postgres last.
   */
  async findLatest(): Promise<StakeSnapshotEntity | null> {
    return this.findOne({ where: {}, order: { readAt: 'DESC' } });
  }
}
