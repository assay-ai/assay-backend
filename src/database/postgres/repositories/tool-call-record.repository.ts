import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';

import { ToolCallRecordEntity } from '../entities/tool-call-record.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';
import { ReceiptsSummaryGroupBy } from './payment-intent.repository';

/** Free calls served in a summary window, for one group key (and UTC day). */
export interface FreeCallsSummaryRow {
  readonly key: string;
  readonly freeCalls: number;
  readonly day?: string;
}

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
   * Free calls served in `[from, to)`, grouped the way
   * `PaymentIntentRepository.summarizeReceipts` groups the paid ones, so
   * `GET /receipts/summary` can count them (`freeCalls`). A refused call served
   * nothing and is not counted; a free call has no asset, so no asset filter
   * applies.
   *
   * The keys match the intent side's: a tool or provider id, a UTC day, the
   * verdict (`UNVERIFIED` when not sampled), the agent, and `agent:<id>` for
   * the credential (a free call does not record one). `status` groups every
   * free call under `FREE`: it has no payment status.
   */
  async summarizeFreeCalls(
    organizationId: string,
    groupBy: ReceiptsSummaryGroupBy,
    window: { readonly from: Date; readonly to: Date },
    options: { readonly byUtcDay?: boolean } = {},
  ): Promise<FreeCallsSummaryRow[]> {
    const groupExpression = freeGroupExpression(groupBy);
    const qb = this.createQueryBuilder('record')
      .select(groupExpression, 'key')
      .addSelect('COUNT(*)', 'freeCalls')
      .where('record.organizationId = :organizationId', { organizationId })
      .andWhere('record.pricing_mode IS NOT NULL')
      .andWhere('record.refusal_code IS NULL')
      .andWhere('record.created_at >= :from', { from: window.from })
      .andWhere('record.created_at < :to', { to: window.to });
    // A constant key (`status`) is not grouped or ordered on: Postgres refuses
    // a literal in either, and there is one group anyway.
    const constant = groupBy === ReceiptsSummaryGroupBy.STATUS;
    if (!constant) qb.groupBy(groupExpression).orderBy(groupExpression, 'ASC');
    if (options.byUtcDay) {
      const dayExpression = freeGroupExpression(ReceiptsSummaryGroupBy.DAY);
      qb.addSelect(dayExpression, 'day').addGroupBy(dayExpression);
      if (constant) qb.orderBy(dayExpression, 'ASC');
    }
    const rows = (await qb.getRawMany<{ key: string; freeCalls: string; day?: string }>()).filter(
      (row) => Number(row.freeCalls) > 0,
    );
    return rows.map((row) => ({
      key: row.key,
      freeCalls: Number(row.freeCalls),
      ...(options.byUtcDay ? { day: row.day } : {}),
    }));
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

/** `summarizeFreeCalls`' group key: the same key the intent side gives the same call. */
function freeGroupExpression(groupBy: ReceiptsSummaryGroupBy): string {
  switch (groupBy) {
    case ReceiptsSummaryGroupBy.TOOL:
      return "COALESCE(record.tool_id, 'unassigned')";
    case ReceiptsSummaryGroupBy.PROVIDER:
      return "COALESCE(record.provider_id::text, 'unassigned')";
    case ReceiptsSummaryGroupBy.DAY:
      return "to_char((record.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')";
    case ReceiptsSummaryGroupBy.STATUS:
      return "'FREE'";
    case ReceiptsSummaryGroupBy.VERDICT:
      return "COALESCE(record.verdict, 'UNVERIFIED')";
    case ReceiptsSummaryGroupBy.AGENT:
      return 'record.agent_id::text';
    case ReceiptsSummaryGroupBy.CREDENTIAL:
      return "'agent:' || record.agent_id::text";
  }
}
