import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { BindingAttemptEntity } from '../entities/binding-attempt.entity';
import { AbstractRepository } from './abstract.repository';

/** One attempt, as the router records it. */
export interface BindingAttemptInput {
  readonly bindingId: string;
  readonly providerId: string;
  readonly buyerOrganizationId: string;
  readonly callClass: string | null;
  readonly available: boolean;
  readonly latencyMs: number | null;
  readonly reason: string;
}

/** One binding's attempt window, aggregated in SQL. */
export interface BindingAttemptWindowRow {
  readonly bindingId: string;
  readonly providerId: string;
  readonly attempts: number;
  readonly availableAttempts: number;
  readonly latencySamples: number;
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
}

/** One UTC day's latency percentiles for one provider's paid attempts. */
export interface DailyLatencyRow {
  readonly day: string;
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
}

/**
 * `binding_attempts` — appended by the router, aggregated and pruned by the
 * stats refresh in the scheduler. Platform data keyed by the provider
 * organization; every query here spans buyer tenants on purpose, because a
 * binding's attempts come from all of them.
 */
@Injectable()
export class BindingAttemptRepository extends AbstractRepository<BindingAttemptEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(BindingAttemptEntity, dataSource);
  }

  /** One multi-row `INSERT` for a batch the recorder buffered. */
  async appendMany(attempts: readonly BindingAttemptInput[]): Promise<void> {
    if (attempts.length === 0) return;
    await this.manager
      .createQueryBuilder()
      .insert()
      .into(BindingAttemptEntity)
      .values(attempts.map((attempt) => ({ ...attempt })))
      .execute();
  }

  /**
   * Each binding's window, as counts and the two latency percentiles.
   *
   * Two caps, in this order: each buyer organization's last `maxPerBuyer`
   * attempts on the binding, then the binding's last `windowSize` of what is
   * left, none older than `since`. The first is what stops one buyer — whose
   * voided failures cost it nothing — from filling a competitor's window.
   *
   * `percentile_disc` rather than `percentile_cont`: the answer is a latency
   * some call actually had, not an interpolation between two. Both ignore the
   * `NULL` latencies of attempts that were not latency samples.
   */
  async aggregateWindows(
    windowSize: number,
    maxPerBuyer: number,
    since: Date,
  ): Promise<BindingAttemptWindowRow[]> {
    const rows: Record<string, unknown>[] = await this.manager.query(
      `SELECT w.binding_id AS "bindingId",
              w.provider_id AS "providerId",
              count(*)::int AS "attempts",
              count(*) FILTER (WHERE w.available)::int AS "availableAttempts",
              count(w.latency_ms)::int AS "latencySamples",
              percentile_disc(0.5) WITHIN GROUP (ORDER BY w.latency_ms) AS "p50LatencyMs",
              percentile_disc(0.95) WITHIN GROUP (ORDER BY w.latency_ms) AS "p95LatencyMs"
         FROM (
           SELECT c.*,
                  row_number() OVER (PARTITION BY c.binding_id
                                     ORDER BY c.created_at DESC, c.id DESC) AS rn
             FROM (
               SELECT id, binding_id, provider_id, available, latency_ms, created_at,
                      row_number() OVER (PARTITION BY binding_id, buyer_organization_id
                                         ORDER BY created_at DESC, id DESC) AS rb
                 FROM binding_attempts
                WHERE created_at >= $1
                  AND call_class = 'PAID'
                  AND buyer_organization_id <> provider_id
             ) c
            WHERE c.rb <= $3
         ) w
        WHERE w.rn <= $2
        GROUP BY w.binding_id, w.provider_id`,
      [since, windowSize, maxPerBuyer],
    );
    return rows.map((row) => ({
      bindingId: String(row.bindingId),
      providerId: String(row.providerId),
      attempts: Number(row.attempts),
      availableAttempts: Number(row.availableAttempts),
      latencySamples: Number(row.latencySamples),
      p50LatencyMs: nullableNumber(row.p50LatencyMs),
      p95LatencyMs: nullableNumber(row.p95LatencyMs),
    }));
  }

  /**
   * Drop everything no window will read again: rows older than `before`, rows
   * past a buyer's last `maxPerBuyer` on a binding, and rows past the
   * binding's last `windowSize` of what remains — the same two caps
   * {@link aggregateWindows} applies, so the table is the window. Each buyer
   * keeps its own rows, so a flood from one buyer cannot evict another's.
   * Returns how many went.
   */
  async prune(windowSize: number, maxPerBuyer: number, before: Date): Promise<number> {
    const aged = await this.manager.query(`DELETE FROM binding_attempts WHERE created_at < $1`, [
      before,
    ]);
    const overflow = await this.manager.query(
      `DELETE FROM binding_attempts a
        USING (
          SELECT id FROM (
            SELECT id, rb,
                   CASE WHEN rb <= $2
                        THEN row_number() OVER (PARTITION BY binding_id, rb <= $2
                                                ORDER BY created_at DESC, id DESC)
                   END AS rn
              FROM (
                SELECT id, binding_id, created_at,
                       row_number() OVER (PARTITION BY binding_id, buyer_organization_id
                                          ORDER BY created_at DESC, id DESC) AS rb
                  FROM binding_attempts
              ) ranked
          ) r
           WHERE r.rb > $2 OR r.rn > $1
        ) old
        WHERE a.id = old.id`,
      [windowSize, maxPerBuyer],
    );
    return affected(aged) + affected(overflow);
  }

  /**
   * Per UTC day, the p50/p95 of one provider's PAID attempts in `[from, to)`.
   * Days outside the retained window are simply absent.
   */
  async dailyPaidLatency(providerId: string, from: Date, to: Date): Promise<DailyLatencyRow[]> {
    const rows: Record<string, unknown>[] = await this.manager.query(
      `SELECT to_char((a.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS "day",
              percentile_disc(0.5) WITHIN GROUP (ORDER BY a.latency_ms) AS "p50LatencyMs",
              percentile_disc(0.95) WITHIN GROUP (ORDER BY a.latency_ms) AS "p95LatencyMs"
         FROM binding_attempts a
        WHERE a.provider_id = $1
          AND a.created_at >= $2
          AND a.created_at < $3
          AND a.call_class = 'PAID'
          AND a.latency_ms IS NOT NULL
        GROUP BY 1`,
      [providerId, from, to],
    );
    return rows.map((row) => ({
      day: String(row.day),
      p50LatencyMs: nullableNumber(row.p50LatencyMs),
      p95LatencyMs: nullableNumber(row.p95LatencyMs),
    }));
  }
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** node-postgres answers a raw `DELETE` with `[rows, rowCount]`. */
function affected(result: unknown): number {
  if (Array.isArray(result) && typeof result[1] === 'number') return result[1];
  return 0;
}
