import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { PaymentIntentEntity } from '../entities/payment-intent.entity';
import { SlashProposalEntity } from '../entities/slash-proposal.entity';
import { VerificationPolicyEntity } from '../entities/verification-policy.entity';
import { VerificationRecordEntity } from '../entities/verification-record.entity';

/**
 * The platform-wide aggregates behind `GET /operator/health`.
 *
 * **Deliberately cross-organization**, on the same terms as
 * `VerificationRecordRepository.findUnsettled` and `SlashProposalRepository.findQueue`:
 * a platform-health tile has no tenant of its own, and a query that had to
 * enumerate organizations would miss the next one onboarded. Every method here
 * uses `this.dataSource.createQueryBuilder(Entity, alias)` rather than an
 * `OrganizationScopedRepository`, for the same reason those two do — the guard
 * that class carries exists to stop a request-serving query that *forgot* its
 * tenant, and it has no way to express "every tenant, on purpose".
 *
 * This repository owns no entity and is not an `OrganizationScopedRepository`
 * subclass. It reads four tables that already have owning repositories
 * elsewhere in the codebase; adding cross-organization methods to any of them
 * would be a second, harder-to-audit way to bypass the same guard, so the
 * aggregates live here instead — one small, clearly-labelled file rather than
 * a scope exception buried in four others.
 */
@Injectable()
export class PlatformMetricsRepository {
  constructor(@InjectDataSource('postgres') private readonly dataSource: DataSource) {}

  /**
   * `intentsPerMinute` and the one-hour-ago figure it is compared against.
   *
   * Both counts come out of one query so the two numbers describe the same
   * instant of `now` — two round trips could straddle a clock tick and make a
   * flat rate look like a swing.
   *
   * `payment_intents` has no index on `created_at` alone (only
   * `(status, expires_at)` and `(organization_id, agent_id)`), so this is a
   * bounded sequential scan over roughly the last 61 minutes rather than an
   * index range scan. Acceptable for a tile polled at dashboard cadence; a
   * dedicated index would be the fix if this ever needs to run more often.
   */
  async intentRateCounts(now: Date): Promise<{ lastMinute: number; hourAgoMinute: number }> {
    const lastMinuteStart = new Date(now.getTime() - 60_000);
    const hourAgoEnd = new Date(now.getTime() - 60 * 60_000);
    const hourAgoStart = new Date(hourAgoEnd.getTime() - 60_000);

    const row = await this.dataSource
      .createQueryBuilder(PaymentIntentEntity, 'intent')
      .select(
        'COUNT(*) FILTER (WHERE intent.created_at >= :lastMinuteStart AND intent.created_at < :now)::int',
        'lastMinute',
      )
      .addSelect(
        'COUNT(*) FILTER (WHERE intent.created_at >= :hourAgoStart AND intent.created_at < :hourAgoEnd)::int',
        'hourAgoMinute',
      )
      .where('intent.created_at >= :hourAgoStart')
      .andWhere('intent.created_at < :now')
      .setParameters({ lastMinuteStart, now, hourAgoStart, hourAgoEnd })
      .getRawOne<{ lastMinute: number; hourAgoMinute: number }>();

    return row ?? { lastMinute: 0, hourAgoMinute: 0 };
  }

  /**
   * The verification backlog: records still `PENDING`, and the p95 age of that
   * backlog in seconds.
   *
   * `PERCENTILE_CONT` over an empty set is `NULL` in Postgres — exactly the
   * "null when the backlog is empty" the DTO asks for, with no special case
   * needed in this method.
   */
  async verificationBacklog(now: Date): Promise<{ count: number; p95AgeSeconds: number | null }> {
    const row = await this.dataSource
      .createQueryBuilder(VerificationRecordEntity, 'record')
      .select('COUNT(*)::int', 'count')
      .addSelect(
        'PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (:now::timestamptz - record.created_at)))::float8',
        'p95AgeSeconds',
      )
      .where('record.state = :pending', { pending: 'PENDING' })
      .setParameter('now', now)
      .getRawOne<{ count: number; p95AgeSeconds: number | string | null }>();

    return {
      count: row?.count ?? 0,
      p95AgeSeconds: toFiniteNumberOrNull(row?.p95AgeSeconds),
    };
  }

  /**
   * `policiesInShadow` / `policiesTotal`.
   *
   * `total` counts `SHADOW` and `ACTIVE` rows only — the two lifecycles
   * `SERVING_LIFECYCLES` names as actually resolved for a live call. `DRAFT`
   * rows have never served traffic and `WITHDRAWN`/`ARCHIVED` rows have
   * stopped; folding either into "total" would make the tile's denominator a
   * count of rows in a table rather than a count of policies an operator could
   * currently be asked to act on.
   */
  async policyLifecycleCounts(): Promise<{ shadow: number; total: number }> {
    const row = await this.dataSource
      .createQueryBuilder(VerificationPolicyEntity, 'policy')
      .select("COUNT(*) FILTER (WHERE policy.lifecycle = 'SHADOW')::int", 'shadow')
      .addSelect("COUNT(*) FILTER (WHERE policy.lifecycle IN ('SHADOW', 'ACTIVE'))::int", 'total')
      .getRawOne<{ shadow: number; total: number }>();

    return row ?? { shadow: 0, total: 0 };
  }

  /**
   * `openDisputes` / `oldestOpenDisputeAgeSeconds`.
   *
   * Age is measured from `disputed_at` — when the case *became* one of these
   * three statuses — not `proposed_at`, which can predate the dispute by
   * however long the provider took to object. Every status in this set is
   * only reachable through `DISPUTED` first (see `SlashProposalEntity`'s
   * state diagram), so `disputed_at` is expected to be set on every row this
   * matches; `MIN` simply ignores any row where it is not.
   */
  async openSlashProposalCounts(
    now: Date,
  ): Promise<{ count: number; oldestAgeSeconds: number | null }> {
    const row = await this.dataSource
      .createQueryBuilder(SlashProposalEntity, 'proposal')
      .select('COUNT(*)::int', 'count')
      .addSelect(
        'EXTRACT(EPOCH FROM (:now::timestamptz - MIN(proposal.disputed_at)))::float8',
        'oldestAgeSeconds',
      )
      .where('proposal.status IN (:...open)', {
        open: ['DISPUTED', 'UNDER_REVIEW', 'AWAITING_SECOND'],
      })
      .setParameter('now', now)
      .getRawOne<{ count: number; oldestAgeSeconds: number | string | null }>();

    return {
      count: row?.count ?? 0,
      oldestAgeSeconds: toFiniteNumberOrNull(row?.oldestAgeSeconds),
    };
  }
}

/**
 * Postgres/`pg` sometimes hands back a `double precision` as a string
 * depending on the driver's type parser configuration. Normalised once, here,
 * rather than trusting every call site to remember — and `NULL`/`NaN` both
 * become `null`, never a fabricated `0`.
 */
function toFiniteNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
