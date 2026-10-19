import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { EvidencePackEntity } from '../entities/evidence-pack.entity';
import { SlaWindowCallEntity } from '../entities/sla-window-call.entity';

/**
 * Cross-entity reads for the slash case brief
 * that no single owning repository can answer.
 *
 * A new file rather than a new method on `EvidencePackRepository` or
 * `SlaWindowRepository`: those two belong to the evidence pack and the SLA
 * windows respectively, and a join that needs both is not naturally either
 * one's to own. Same shape as `PlatformMetricsRepository` for the same reason —
 * a plain class over `DataSource` rather than an
 * `OrganizationScopedRepository`, because the guard that class carries is keyed
 * to a single entity's `createQueryBuilder` and has no way to express a
 * two-table join or a deliberate cross-tenant read. Every method here states
 * which of those two shapes it is and scopes accordingly in its own SQL.
 */
@Injectable()
export class SlashCaseReadRepository {
  constructor(@InjectDataSource('postgres') private readonly dataSource: DataSource) {}

  /**
   * `evidenceVerdictCount` — evidence packs sealed for calls posted to one
   * window.
   *
   * `evidence_packs` carries no `window_id` of its own — evidence packs predate
   * SLA windows — so the join is through `sla_window_calls.intent_id`, the only
   * column the two tables share a meaning for. A SQL subquery rather than an
   * app-side `IN` list built from `SlaWindowCallRepository.findByWindow`'s
   * capped rows: the count then stays exact even for a window with more calls
   * than that cap, and Postgres performs the join instead of the driver
   * shipping a multi-thousand-id list twice.
   *
   * Single-tenant. Both halves of the join are scoped to `organizationId`
   * explicitly — unlike {@link countPeerBindingsWithMaterialDeviation} below,
   * there is no reason for this read to cross a tenant boundary.
   */
  async countEvidencePacksForWindow(organizationId: string, windowId: string): Promise<number> {
    const row = await this.dataSource
      .createQueryBuilder(EvidencePackEntity, 'pack')
      .select('COUNT(*)::int', 'count')
      .where('pack.organizationId = :organizationId', { organizationId })
      .andWhere((qb) => {
        const subQuery = qb
          .subQuery()
          .select('call.intentId')
          .from(SlaWindowCallEntity, 'call')
          .where('call.organizationId = :organizationId')
          .andWhere('call.windowId = :windowId')
          .getQuery();
        return `pack.intentId IN ${subQuery}`;
      })
      .setParameters({ organizationId, windowId })
      .getRawOne<{ count: number }>();

    return row?.count ?? 0;
  }
}
