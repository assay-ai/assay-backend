import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';

import { BindingStatsEntity } from '../entities/binding-stats.entity';
import { AbstractRepository } from './abstract.repository';

/** One binding's window, the shape `binding_stats` stores. */
export interface BindingStatsRow {
  readonly bindingId: string;
  readonly providerId: string;
  readonly attempts: number;
  readonly availableAttempts: number;
  readonly latencySamples: number;
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly verdicts: number;
  readonly passedVerdicts: number;
}

/** One binding's quality-bearing verdicts, aggregated in SQL. */
export interface BindingVerdictWindowRow {
  readonly bindingId: string;
  readonly providerId: string;
  readonly verdicts: number;
  readonly passedVerdicts: number;
}

export interface VerdictWindowQuery {
  readonly windowSize: number;
  /** The most verdicts one buyer organization adds to a binding's window. */
  readonly maxPerBuyer: number;
  readonly since: Date;
  /** The verdict statuses that move the quality metric (`PASS`, `FAIL`). */
  readonly qualityStatuses: readonly string[];
  /** The one of those that counts as a pass. */
  readonly passStatus: string;
}

/** Rows written per statement; well under Postgres' 65,535 bind-parameter limit. */
const UPSERT_CHUNK = 500;

/**
 * `binding_stats` — the refresh's snapshot, read on every routing decision.
 *
 * Also home to the verdict half of the refresh, because it reads two tables
 * (`verification_records` joined to `payment_intents` for the binding and the
 * buyer) that neither of their own repositories has a reason to know about.
 * Cross-tenant on purpose, like `ProviderTrafficService`: a binding's verdicts
 * are spread over every buyer organization that called it.
 */
@Injectable()
export class BindingStatsRepository extends AbstractRepository<BindingStatsEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(BindingStatsEntity, dataSource);
  }

  /** Every stored window of these providers' bindings — one statement per routing decision. */
  async findByProviders(providerIds: readonly string[]): Promise<BindingStatsRow[]> {
    if (providerIds.length === 0) return [];
    const rows = await this.find({ where: { providerId: In([...new Set(providerIds)]) } });
    return rows.map(toRow);
  }

  /**
   * Each binding's quality-bearing verdicts since `since`: each buyer
   * organization's last `maxPerBuyer`, then the binding's last `windowSize`
   * of those — the same two caps as the attempt window.
   *
   * Left out: shadow-policy verdicts (no economic effect, so no routing effect
   * either — a bad rule in shadow must not move traffic before it is
   * promoted); self-calls, where the buying organization is the provider; and
   * intents that never named a binding or a provider.
   *
   * The scan is bounded by `idx_verification_records_judged_created` (the
   * last 7 days of judged records); the ranking bounds each binding to its
   * last `windowSize`.
   */
  async aggregateVerdictWindows(query: VerdictWindowQuery): Promise<BindingVerdictWindowRow[]> {
    const rows: Record<string, unknown>[] = await this.manager.query(
      `SELECT v.binding_id AS "bindingId",
              v.provider_id AS "providerId",
              count(*)::int AS "verdicts",
              count(*) FILTER (WHERE v.verdict_status = $4)::int AS "passedVerdicts"
         FROM (
           SELECT c.*,
                  row_number() OVER (PARTITION BY c.binding_id
                                     ORDER BY c.created_at DESC, c.id DESC) AS rn
             FROM (
               SELECT r.id, r.created_at, i.binding_id, i.provider_id, r.verdict_status,
                      row_number() OVER (PARTITION BY i.binding_id, r.organization_id
                                         ORDER BY r.created_at DESC, r.id DESC) AS rb
                 FROM verification_records r
                 JOIN payment_intents i ON i.id = r.intent_id
                WHERE r.state IN ('JUDGED', 'SETTLED')
                  AND r.created_at >= $1
                  AND r.verdict_status = ANY($3)
                  AND (r.lifecycle IS NULL OR r.lifecycle <> 'SHADOW')
                  AND i.binding_id IS NOT NULL
                  AND i.provider_id IS NOT NULL
                  AND r.organization_id IS NOT NULL
                  AND r.organization_id <> i.provider_id
                  AND i.organization_id <> i.provider_id
             ) c
            WHERE c.rb <= $5
         ) v
        WHERE v.rn <= $2
        GROUP BY v.binding_id, v.provider_id`,
      [
        query.since,
        query.windowSize,
        [...query.qualityStatuses],
        query.passStatus,
        query.maxPerBuyer,
      ],
    );
    return rows.map((row) => ({
      bindingId: String(row.bindingId),
      providerId: String(row.providerId),
      verdicts: Number(row.verdicts),
      passedVerdicts: Number(row.passedVerdicts),
    }));
  }

  /**
   * Make `rows` the whole snapshot, in one transaction: upsert each, then drop
   * every row this refresh did not write. A binding whose window emptied (no
   * attempt and no verdict left inside it) goes back to "not measured", which
   * is what it is.
   */
  async replaceAll(rows: readonly BindingStatsRow[], refreshedAt: Date): Promise<void> {
    await this.manager.transaction(async (manager) => {
      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        const chunk = rows.slice(i, i + UPSERT_CHUNK).map((row) => ({ ...row, refreshedAt }));
        await manager
          .createQueryBuilder()
          .insert()
          .into(BindingStatsEntity)
          .values(chunk)
          .orUpdate(
            [
              'provider_id',
              'attempts',
              'available_attempts',
              'latency_samples',
              'p50_latency_ms',
              'p95_latency_ms',
              'verdicts',
              'passed_verdicts',
              'refreshed_at',
              'updated_at',
            ],
            ['binding_id'],
          )
          .execute();
      }
      await manager
        .createQueryBuilder()
        .delete()
        .from(BindingStatsEntity)
        .where('refreshed_at < :refreshedAt', { refreshedAt })
        .execute();
    });
  }
}

function toRow(row: BindingStatsEntity): BindingStatsRow {
  return {
    bindingId: row.bindingId,
    providerId: row.providerId,
    attempts: row.attempts,
    availableAttempts: row.availableAttempts,
    latencySamples: row.latencySamples,
    p50LatencyMs: row.p50LatencyMs,
    p95LatencyMs: row.p95LatencyMs,
    verdicts: row.verdicts,
    passedVerdicts: row.passedVerdicts,
  };
}
