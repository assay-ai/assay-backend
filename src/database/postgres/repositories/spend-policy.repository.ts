import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';

import { SpendPolicyEntity } from '../entities/spend-policy.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/**
 * The live spend policy, and every version behind it.
 *
 * "Live" is `superseded_at IS NULL`, enforced by a partial unique index rather
 * than by convention — see `1756000000000-create-api-surface-tables`.
 */
@Injectable()
export class SpendPolicyRepository extends OrganizationScopedRepository<SpendPolicyEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(SpendPolicyEntity, dataSource);
  }

  /**
   * The policy in force for an agent, falling back to the organization default.
   *
   * Two queries rather than one `ORDER BY agent_id NULLS LAST`, because the
   * fallback is a *decision* ("this agent has no override") and expressing it as
   * a sort makes it look like a tie-break. Both are index seeks on the partial
   * unique indexes.
   */
  async findLive(organizationId: string, agentId?: string): Promise<SpendPolicyEntity | null> {
    if (agentId) {
      const override = await this.findOne({
        where: { organizationId, agentId, supersededAt: IsNull() },
      });
      if (override) return override;
    }

    return this.findOne({
      where: { organizationId, agentId: IsNull(), supersededAt: IsNull() },
    });
  }
}
