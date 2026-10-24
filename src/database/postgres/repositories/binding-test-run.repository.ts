import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';

import { BindingTestRunEntity } from '../entities/binding-test-run.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/**
 * `binding_test_runs`.
 *
 * Organization-scoped throughout: a tester run belongs to the provider who ran
 * it, the publish gate reads only their own, and nothing about a sandbox call
 * is another tenant's business.
 */
@Injectable()
export class BindingTestRunRepository extends OrganizationScopedRepository<BindingTestRunEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(BindingTestRunEntity, dataSource);
  }

  /**
   * The newest run for one binding **at one revision**, or `null`.
   *
   * The revision is part of the key, not a filter applied afterwards, because
   * that is exactly what the publish gate is asking: not "has this binding
   * ever passed" but "has *what I am about to publish* passed". A run against
   * revision 3 says nothing about revision 4, and the difference between those
   * two questions is a mapping edited after the tester went green. A list of
   * revisions is the same question asked of revisions with the same call
   * (`revisionsWithSameCall`): one that changed only the price, for instance.
   */
  async findLatestForRevision(
    organizationId: string,
    bindingId: string,
    mappingVersion: number | readonly number[],
  ): Promise<BindingTestRunEntity | null> {
    const rows = await this.find({
      where: { organizationId, bindingId, mappingVersion: revisionFilter(mappingVersion) },
      order: { createdAt: 'DESC' },
      take: 1,
    });

    return rows[0] ?? null;
  }

  /**
   * The newest run at one revision **per contract version tested**, newest
   * first — what the publish gate reads to find a run for each major in the
   * binding's range (T3).
   *
   * A list of revisions reads the runs of all of them, newest first: the
   * revisions whose call is the same as the one about to go live
   * (`revisionsWithSameCall`, BUG-PRV-CATALOG-02).
   */
  async findForRevision(
    organizationId: string,
    bindingId: string,
    mappingVersion: number | readonly number[],
  ): Promise<BindingTestRunEntity[]> {
    return this.find({
      where: { organizationId, bindingId, mappingVersion: revisionFilter(mappingVersion) },
      order: { createdAt: 'DESC' },
      take: 200,
    });
  }
}

function revisionFilter(mappingVersion: number | readonly number[]) {
  return typeof mappingVersion === 'number' ? mappingVersion : In([...mappingVersion]);
}
