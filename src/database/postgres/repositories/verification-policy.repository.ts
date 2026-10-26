import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { VerificationPolicyEntity } from '../entities/verification-policy.entity';
import { AbstractRepository } from './abstract.repository';

/**
 * Verification policy versions.
 *
 * `AbstractRepository`, not `OrganizationScopedRepository` — see the entity for
 * why this table belongs to no organization.
 *
 * Every write here is a lifecycle transition and every one of them is a
 * compare-and-swap on `lifecycle`, for the same reason
 * `PaymentIntentRepository.transitionIfInStatus` is: two operators racing the
 * same promotion must produce one promotion and one loser who is *told* they
 * lost, not two writes where the second silently overwrites the first's audit
 * fields.
 */
@Injectable()
export class VerificationPolicyRepository extends AbstractRepository<VerificationPolicyEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(VerificationPolicyEntity, dataSource);
  }

  /**
   * This repository, or the same table through a transaction's manager — so a
   * lifecycle write can share the override log's transaction.
   */
  on(manager?: EntityManager): Repository<VerificationPolicyEntity> {
    return manager ? manager.getRepository(VerificationPolicyEntity) : this;
  }

  findVersion(
    policyId: string,
    policyVersion: number,
    manager?: EntityManager,
  ): Promise<VerificationPolicyEntity | null> {
    return this.on(manager).findOne({ where: { policyId, policyVersion } });
  }

  /**
   * The policy this tool's calls are resolved against right now.
   *
   * `ACTIVE` beats `SHADOW` beats `WITHDRAWN`, and the partial unique indexes
   * guarantee at most one of the first two — so the choice is never a coin
   * flip. `DRAFT` and `ARCHIVED` are never returned: one has not started
   * serving and the other has stopped.
   *
   * **`WITHDRAWN` is returned on purpose.** It is not a fallback to enforcing —
   * `enforces()` says no, and the aggregator short-circuits such a call into
   * `withdrawnVerdict`. It is returned so the call can be *told what happened*:
   * a receipt that names the pulled version and a metric that counts what the
   * withdrawal affected. Dropping the row instead would make a withdrawn policy
   * indistinguishable from a tool nobody ever wrote a policy for.
   */
  async findServing(toolId: string): Promise<VerificationPolicyEntity | null> {
    const active = await this.findOne({ where: { toolId, lifecycle: 'ACTIVE' } });
    if (active) return active;

    const shadow = await this.findOne({ where: { toolId, lifecycle: 'SHADOW' } });
    if (shadow) return shadow;

    // Several versions of one tool can be withdrawn over time; the most
    // recently pulled is the one whose reason describes the current incident.
    return this.findOne({
      where: { toolId, lifecycle: 'WITHDRAWN' },
      order: { withdrawnAt: 'DESC' },
    });
  }

  /** The highest version number registered under this id, or `0` if none. */
  async latestVersion(policyId: string, manager?: EntityManager): Promise<number> {
    const latest = await this.on(manager).findOne({
      where: { policyId },
      order: { policyVersion: 'DESC' },
    });
    return latest?.policyVersion ?? 0;
  }

  /**
   * Moves a version between lifecycles, conditionally.
   *
   * Returns the number of rows changed, so a caller that expected to win and
   * did not finds out. Zero means somebody else moved this version first —
   * during an incident that is the difference between "I withdrew it" and "I
   * believe I withdrew it".
   */
  async transitionIfInLifecycle(
    policyId: string,
    policyVersion: number,
    from: string,
    to: string,
    patch: Partial<VerificationPolicyEntity> = {},
    manager?: EntityManager,
  ): Promise<number> {
    const result = await this.on(manager).update(
      { policyId, policyVersion, lifecycle: from },
      { ...patch, lifecycle: to },
    );
    return result.affected ?? 0;
  }
}
