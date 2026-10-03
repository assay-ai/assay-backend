import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { EvidencePackEntity } from '../entities/evidence-pack.entity';
import { SlaWindowCallEntity } from '../entities/sla-window-call.entity';
import { SlaWindowEntity } from '../entities/sla-window.entity';

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

  /**
   * `coFailureCount` — other bindings on the same tool whose OWN observed
   * failure rate deviated materially from their OWN declared rate, in a
   * closed window overlapping the subject window's time range.
   *
   * **Deliberately cross-organization**, on the same terms as
   * `ProviderSlaWindowsService.peerRowsForTool`: a co-failure signal is a
   * question about every provider implementing the tool, not about the
   * disputing provider alone, and `organizationId IS NOT NULL` is the same
   * idiom used there to prove the cross-tenant read is on purpose rather than
   * a forgotten scope.
   *
   * Comparing each peer window against its OWN `declared_failure_rate` — rather
   * than against that binding's own prior window, which would need a `LAG()`
   * self-join — is a deliberate simplification: it answers "did this peer also
   * look anomalous during the same period", which is the signal the case
   * decision screen's co-failure panel wants, in one indexed-friendly scan
   * instead of a window function over the whole table. `materialDeviation` is
   * supplied by the caller rather than fixed here — see
   * `MATERIAL_FAILURE_RATE_DELTA` at the call site in `SlashCaseService` for
   * why the number is a judgement call, not a documented rule.
   */
  async countPeerBindingsWithMaterialDeviation(
    toolId: string,
    excludeBindingId: string,
    from: Date,
    to: Date,
    materialDeviation: number,
  ): Promise<number> {
    const row = await this.dataSource
      /*
        Two things here are load-bearing and both were found the hard way, on
        the first adjudication queue that was not empty.

        1. The alias is NOT `window`. `WINDOW` is a reserved word in
           PostgreSQL, and TypeORM does not quote the alias inside a raw
           expression, so `COUNT(DISTINCT window.…)` reaches the server as a
           syntax error.
        2. The column names are written in SNAKE CASE. TypeORM rewrites
           `alias.propertyName` only in the simple property paths it
           recognises, not inside a function call or an arithmetic
           expression — so a camelCase property inside `COUNT(...)` or
           `ABS(...)` arrives verbatim, is folded to lower case by Postgres,
           and fails as `column sla_window.failedcalls does not exist`.

        This stayed hidden because the method only runs for a queue row whose
        proposal carries a window. An empty queue never reaches it, and that
        is the state every test and every manual check happened to run in.
      */
      .createQueryBuilder(SlaWindowEntity, 'sla_window')
      .select('COUNT(DISTINCT sla_window.binding_id)::int', 'count')
      .where('sla_window.organization_id IS NOT NULL')
      .andWhere('sla_window.tool_id = :toolId', { toolId })
      .andWhere('sla_window.binding_id != :excludeBindingId', { excludeBindingId })
      .andWhere('sla_window.status = :status', { status: 'CLOSED' })
      .andWhere('sla_window.verified_calls > 0')
      .andWhere('sla_window.opened_at <= :to', { to })
      .andWhere('(sla_window.closed_at IS NULL OR sla_window.closed_at >= :from)', { from })
      .andWhere(
        'ABS(sla_window.failed_calls::float / sla_window.verified_calls - ' +
          'sla_window.declared_failure_rate::float) >= :materialDeviation',
        { materialDeviation },
      )
      .getRawOne<{ count: number }>();

    return row?.count ?? 0;
  }
}
