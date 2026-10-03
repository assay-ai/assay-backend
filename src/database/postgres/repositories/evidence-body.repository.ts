import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, QueryRunner } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { EvidenceBodyEntity } from '../entities/evidence-body.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/**
 * `evidence_bodies` — the raw bodies, until they expire.
 *
 * Has a delete and no update, the exact opposite of
 * `EvidencePackRepository`'s shape, for the reason the two tables are separate
 * at all: a body disappearing on schedule is the published retention policy
 * being kept, a body changing is evidence being rewritten.
 */
@Injectable()
export class EvidenceBodyRepository extends OrganizationScopedRepository<EvidenceBodyEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(EvidenceBodyEntity, dataSource);
  }

  /**
   * Writes the raw bodies inside the caller's transaction.
   *
   * Same transaction as the pack, deliberately: a pack sealed without its
   * bodies would be an evidence pack that never had the evidence, and the gap
   * would be invisible — indistinguishable, three days later, from a body that
   * expired on schedule.
   */
  async insertBody(
    queryRunner: QueryRunner,
    row: QueryDeepPartialEntity<EvidenceBodyEntity>,
  ): Promise<void> {
    await queryRunner.manager.insert(EvidenceBodyEntity, row);
  }

  async findByPackId(organizationId: string, packId: string): Promise<EvidenceBodyEntity | null> {
    return this.findOneBy({ organizationId, packId } as never);
  }

  /**
   * Deletes one batch of expired bodies and says how many went.
   *
   * **Deliberately cross-organization**: the retention promise is the
   * platform's, not a tenant's, and a sweep that had to be told which
   * organizations exist would keep a body forever the first time a new tenant
   * was missed. Batched because the alternative is one statement holding locks
   * over every expired row on the hour, and the sweep has no deadline that
   * makes that worth it — it runs again in an hour.
   *
   * Two statements rather than one `DELETE … WHERE id IN (SELECT … LIMIT)`,
   * because `query()` is disabled on a scoped repository — raw SQL is exactly
   * the hole the scope guard exists to close, and this class is not the place to
   * argue for an exception. The select carries the documented
   * `organizationId IS NOT NULL` escape; the deletes are ordinary scoped deletes,
   * one per organization in the batch. A row that another sweep removes between
   * the two statements simply is not in the count.
   */
  async deleteExpired(now: Date, limit: number): Promise<number> {
    const expiring = await this.createQueryBuilder('body')
      .select(['body.id', 'body.organizationId'])
      .where('body.organizationId IS NOT NULL')
      .andWhere('body.expiresAt < :now', { now })
      .orderBy('body.expiresAt', 'ASC')
      .limit(limit)
      .getMany();

    if (expiring.length === 0) {
      return 0;
    }

    const byOrganization = new Map<string, string[]>();
    for (const body of expiring) {
      const ids = byOrganization.get(body.organizationId) ?? [];
      ids.push(body.id);
      byOrganization.set(body.organizationId, ids);
    }

    let deleted = 0;
    for (const [organizationId, ids] of byOrganization) {
      const result = await this.delete({ organizationId, id: In(ids) } as never);
      deleted += result.affected ?? 0;
    }

    return deleted;
  }
}
