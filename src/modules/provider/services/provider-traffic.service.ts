import { Injectable, Optional } from '@nestjs/common';

import {
  BindingAttemptRepository,
  DailyLatencyRow,
} from '@database/postgres/repositories/binding-attempt.repository';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';

import {
  GetProviderTrafficQueryDto,
  GetProviderTrafficResponseDto,
  ProviderAgentTrafficDto,
  ProviderStatusCountDto,
  ProviderTrafficBucketDto,
} from '../dto/get-provider-traffic.dto';
import { ProviderErrors } from '../errors/provider.errors';
import { dayExpr } from './day-bucket.util';

const DAY_EXPR = dayExpr('intent');

/**
 * How many agents the per-agent breakdown returns. Bounded rather than
 * paginated: this is a "who's calling me" glance for a chart/table on the
 * traffic screen, not a list a caller pages through — a provider wants the
 * few callers that dominate their volume, not the long tail. Ten is the same
 * order of magnitude the quality screen's other top-N surfaces use.
 */
const AGENT_BREAKDOWN_LIMIT = 10;

interface TrafficRow {
  readonly day: string;
  readonly status: string;
  readonly calls: string;
}

interface AgentTrafficRow {
  readonly agentId: string;
  readonly status: string;
  readonly calls: string;
}

/**
 * `GET /providers/me/traffic` — the provider's traffic screens.
 *
 * **Deliberately cross-organization**, like `PaymentIntentRepository.
 * findDueForExpiry` and `LedgerEntryRepository.sumByEntryType`, and for the
 * same reason spelled out there: a provider's traffic is served to buyer
 * organizations the provider has no membership in, so "this provider's
 * calls" is inherently a query across every calling tenant, filtered by
 * `provider_id` rather than by the provider's own `organization_id`.
 * `OrganizationScopedRepository.createQueryBuilder`'s guard only proves the
 * built SQL *references* `organization_id`; it does not and cannot prove it
 * is bound to the caller, so a `WHERE organization_id IS NOT NULL` (always
 * true — the column has a `NOT NULL` constraint) is what satisfies it here.
 *
 * The per-agent view adds an agent dimension on top of that: an optional `agentId`
 * filter, and an agent breakdown alongside the existing day/status buckets.
 * `payment_intents.agent_id` is the only per-call agent identifier that
 * exists — there is no `mcp_sessions` table — so it is also the only column
 * this can group by. Two separate queries rather than one wider `GROUP BY
 * day, status, agent_id`: folding the agent dimension into the day buckets
 * would multiply their row count by the number of distinct agents for no
 * reason the day buckets need, and ranking "top agents by total calls" needs
 * a total per agent across the whole window, not per day. Both queries share
 * `idx_payment_intents_provider_created (provider_id, created_at)` for the
 * range selection — `agent_id` (like `status`) is not part of any index and
 * is filtered/grouped over the rows that index scan already produced, same
 * as the existing `status` grouping always has been. Reconsider only if a
 * provider's per-window row count grows enough that this in-memory aggregate
 * (an `Index Scan` on `idx_payment_intents_provider_created` feeding a
 * `HashAggregate` grouped on `agent_id, status`) stops being cheap.
 */
@Injectable()
export class ProviderTrafficService {
  constructor(
    private readonly intents: PaymentIntentRepository,
    // The per-day latency, from the router's `binding_attempts`. Optional:
    // without it the latency fields stay `null`, as they were before.
    @Optional() private readonly attempts: BindingAttemptRepository | null = null,
  ) {}

  async getTraffic(
    providerId: string,
    query: GetProviderTrafficQueryDto,
  ): Promise<GetProviderTrafficResponseDto> {
    const from = new Date(query.from);
    const to = new Date(query.to);

    if (!(from.getTime() < to.getTime())) {
      throw ProviderErrors.invalidTimeRange({ from: query.from, to: query.to });
    }

    const dayRows = await this.scopedIntentQuery(providerId, query, from, to)
      .select(DAY_EXPR, 'day')
      .addSelect('intent.status', 'status')
      .addSelect('COUNT(*)', 'calls')
      .groupBy(DAY_EXPR)
      .addGroupBy('intent.status')
      .orderBy(DAY_EXPR, 'ASC')
      .getRawMany<TrafficRow>();

    const agentRows = await this.scopedIntentQuery(providerId, query, from, to)
      .select('intent.agentId', 'agentId')
      .addSelect('intent.status', 'status')
      .addSelect('COUNT(*)', 'calls')
      .groupBy('intent.agentId')
      .addGroupBy('intent.status')
      .getRawMany<AgentTrafficRow>();

    // Not narrowed by `agentId`: an attempt row records the binding and the
    // provider, not who called, so this is the provider's latency that day.
    const latencyRows = (await this.attempts?.dailyPaidLatency(providerId, from, to)) ?? [];

    const buckets = foldIntoBuckets(dayRows, latencyRows);
    const totalCalls = buckets.reduce((total, bucket) => total + bucket.calls, 0);
    const agentBreakdown = foldIntoAgentBreakdown(agentRows, AGENT_BREAKDOWN_LIMIT);

    return { from: query.from, to: query.to, buckets, totalCalls, agentBreakdown };
  }

  /**
   * The predicates every `traffic` query shares: the cross-organization
   * tautology, the `provider_id` scope, the `[from, to)` window and, when
   * given, the `agentId` filter. Each caller adds its own
   * `select`/`groupBy` on top — a fresh `createQueryBuilder()` per call, not
   * a shared builder instance, since TypeORM query builders accumulate state
   * and this service issues two independently-shaped queries.
   */
  private scopedIntentQuery(
    providerId: string,
    query: GetProviderTrafficQueryDto,
    from: Date,
    to: Date,
  ) {
    const qb = this.intents
      .createQueryBuilder('intent')
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.providerId = :providerId', { providerId })
      .andWhere('intent.createdAt >= :from', { from })
      .andWhere('intent.createdAt < :to', { to });

    if (query.agentId) {
      qb.andWhere('intent.agentId = :agentId', { agentId: query.agentId });
    }

    return qb;
  }
}

function foldIntoBuckets(
  rows: readonly TrafficRow[],
  latencyRows: readonly DailyLatencyRow[],
): ProviderTrafficBucketDto[] {
  const byDay = new Map<string, Map<string, number>>();
  const latencyByDay = new Map(latencyRows.map((row) => [row.day, row]));

  for (const row of rows) {
    const perStatus = byDay.get(row.day) ?? new Map<string, number>();
    perStatus.set(row.status, Number(row.calls));
    byDay.set(row.day, perStatus);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, perStatus]) => {
      const byStatus: ProviderStatusCountDto[] = Object.values(PaymentIntentStatus).map(
        (status) => ({
          status,
          calls: perStatus.get(status) ?? 0,
        }),
      );
      const calls = byStatus.reduce((total, entry) => total + entry.calls, 0);

      const latency = latencyByDay.get(day);
      return {
        day,
        calls,
        byStatus,
        p50LatencyMs: latency?.p50LatencyMs ?? null,
        p95LatencyMs: latency?.p95LatencyMs ?? null,
      };
    });
}

function foldIntoAgentBreakdown(
  rows: readonly AgentTrafficRow[],
  limit: number,
): ProviderAgentTrafficDto[] {
  const byAgent = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const perStatus = byAgent.get(row.agentId) ?? new Map<string, number>();
    perStatus.set(row.status, Number(row.calls));
    byAgent.set(row.agentId, perStatus);
  }

  return [...byAgent.entries()]
    .map(([agentId, perStatus]) => {
      const byStatus: ProviderStatusCountDto[] = Object.values(PaymentIntentStatus).map(
        (status) => ({
          status,
          calls: perStatus.get(status) ?? 0,
        }),
      );
      const calls = byStatus.reduce((total, entry) => total + entry.calls, 0);

      return { agentId, calls, byStatus };
    })
    .sort((a, b) => (b.calls !== a.calls ? b.calls - a.calls : a.agentId < b.agentId ? -1 : 1))
    .slice(0, limit);
}
