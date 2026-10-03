import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { FleetSweepEntity } from '../entities/fleet-sweep.entity';
import { AbstractRepository } from './abstract.repository';

/**
 * `fleet_sweeps`.
 *
 * Not organization-scoped, and could not be: a sweep spans providers, which is
 * the whole of what it is for. The proposals it reaches carry `sweep_id` back
 * here, so a provider reading their own case sees that it was swept and why
 * without this row being visible to them.
 */
@Injectable()
export class FleetSweepRepository extends AbstractRepository<FleetSweepEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(FleetSweepEntity, dataSource);
  }

  /**
   * Close the sweep with its counts.
   *
   * Both counts, always, and the reason is in the entity: they differ
   * legitimately when a matched case was already decided the same way, and
   * reporting only `appliedCount` would make an idempotent re-run look like it
   * did nothing — which is the moment somebody runs it a third time.
   */
  async complete(id: string, matchedCount: number, appliedCount: number): Promise<void> {
    await this.update(
      { id },
      { status: 'COMPLETED', matchedCount, appliedCount, completedAt: new Date() },
    );
  }

  async fail(id: string, matchedCount: number, appliedCount: number): Promise<void> {
    await this.update({ id }, { status: 'FAILED', matchedCount, appliedCount });
  }

  async findRecent(limit: number): Promise<FleetSweepEntity[]> {
    return this.find({ order: { createdAt: 'DESC' }, take: limit });
  }
}
