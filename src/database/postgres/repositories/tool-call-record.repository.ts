import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';

import { ToolCallRecordEntity } from '../entities/tool-call-record.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** What the relay path writes instead of a payment intent. */
@Injectable()
export class ToolCallRecordRepository extends OrganizationScopedRepository<ToolCallRecordEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ToolCallRecordEntity, dataSource);
  }

  /**
   * Free calls this agent made against this binding since `since`.
   *
   * The durable answer behind the per-agent-per-binding quota. Redis holds the
   * live counter; this rebuilds it on a miss, the same read-through shape
   * `BindingCallCounterService` uses and for the same reason — a quota that
   * resets to zero because Redis restarted is a quota an agent clears by
   * waiting for an outage.
   */
  async countForAgentBindingSince(
    organizationId: string,
    agentId: string,
    bindingId: string,
    since: Date,
  ): Promise<number> {
    return (
      this.createQueryBuilder('record')
        .where('record.organizationId = :organizationId', { organizationId })
        .andWhere('record.agentId = :agentId', { agentId })
        .andWhere('record.bindingId = :bindingId', { bindingId })
        .andWhere('record.createdAt >= :since', { since })
        // A refused call served nothing and used no free call.
        .andWhere('record.refusalCode IS NULL')
        .getCount()
    );
  }

  /**
   * Free calls this agent made across every binding since `since` — the
   * platform-wide per-agent daily allowance (`platformAgentDaily`, 1,000).
   */
  async countForAgentSince(organizationId: string, agentId: string, since: Date): Promise<number> {
    return (
      this.createQueryBuilder('record')
        .where('record.organizationId = :organizationId', { organizationId })
        .andWhere('record.agentId = :agentId', { agentId })
        .andWhere('record.createdAt >= :since', { since })
        // A refused call served nothing and used no free call.
        .andWhere('record.refusalCode IS NULL')
        .getCount()
    );
  }

  /**
   * Free calls **every** agent made against this binding since `since`.
   *
   * Cross-organization on purpose, and the only such read here — the mirror of
   * {@link countForAgentBindingSince} and {@link countForAgentSince}, which are
   * both scoped to one calling agent's own organization. The provider's daily
   * *budget* (`tool_bindings.free_daily_budget`) caps a binding's free traffic
   * from every agent that calls it, and those agents buy from many different
   * organizations — the same cross-tenant shape `ToolBindingRepository.findByTool`
   * and `BindingCallCounterService` already rely on for the same reason.
   *
   * `FreeQuotaService` is the only caller, and only to rebuild the Redis
   * counter behind the provider daily budget after a cache miss.
   */
  async countForBindingSince(bindingId: string, since: Date): Promise<number> {
    return (
      this.createQueryBuilder('record')
        .where('record.organizationId IS NOT NULL')
        .andWhere('record.bindingId = :bindingId', { bindingId })
        .andWhere('record.createdAt >= :since', { since })
        // A refused call served nothing and used no free call.
        .andWhere('record.refusalCode IS NULL')
        .getCount()
    );
  }

  /**
   * Every tool this agent has made a free call against, since `since`.
   *
   * `GET /free-quota`'s only way to know which tools to report per-tool
   * headroom for, without asking "what if this agent called every tool in the
   * catalogue" — a question the endpoint has no reason to answer for a tool
   * this agent has never touched.
   */
  async distinctToolIdsForAgentSince(
    organizationId: string,
    agentId: string,
    since: Date,
  ): Promise<string[]> {
    const rows = await this.createQueryBuilder('record')
      .select('DISTINCT record.tool_id', 'toolId')
      .where('record.organizationId = :organizationId', { organizationId })
      .andWhere('record.agentId = :agentId', { agentId })
      .andWhere('record.createdAt >= :since', { since })
      // A refused call served nothing and used no free call.
      .andWhere('record.refusalCode IS NULL')
      .getRawMany<{ toolId: string }>();

    return rows.map((row) => row.toolId);
  }

  /**
   * Deletes one batch of records past their 30-day retention, and says how many
   * went.
   *
   * Modelled on `EvidenceBodyRepository.deleteExpired`, including its reasoning:
   * **deliberately cross-organization**, because the retention promise is the
   * platform's rather than a tenant's and a sweep that had to be told which
   * organizations exist would keep rows forever the first time a new tenant was
   * missed. Batched, because the alternative is one statement holding locks over
   * every expired row and the sweep has no deadline that makes that worth it.
   *
   * Two statements rather than one `DELETE … WHERE id IN (SELECT … LIMIT)`,
   * because `query()` is disabled on a scoped repository and raw SQL is exactly
   * the hole that guard exists to close.
   */
  async deleteExpired(now: Date, limit: number): Promise<number> {
    const expiring = await this.createQueryBuilder('record')
      .select(['record.id', 'record.organizationId'])
      .where('record.organizationId IS NOT NULL')
      .andWhere('record.expiresAt <= :now', { now })
      .orderBy('record.expiresAt', 'ASC')
      .limit(limit)
      .getMany();

    if (expiring.length === 0) {
      return 0;
    }

    const byOrganization = new Map<string, string[]>();
    for (const record of expiring) {
      const ids = byOrganization.get(record.organizationId) ?? [];
      ids.push(record.id);
      byOrganization.set(record.organizationId, ids);
    }

    let deleted = 0;
    for (const [organizationId, ids] of byOrganization) {
      const result = await this.delete({ organizationId, id: In(ids) } as never);
      deleted += result.affected ?? 0;
    }

    return deleted;
  }
}
