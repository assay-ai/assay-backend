import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SlaWindowEntity } from '../entities/sla-window.entity';
import { assertOrganizationScopedCriteria } from '../organization-scope';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** `sla_windows.status` — kept as plain strings here, matching the entity. */
const OPEN = 'OPEN';
const CLOSED = 'CLOSED';

/** How far back the public failure rate looks (owner decision D5). */
export const PUBLIC_QUALITY_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A window past its `deadlineAt`, from any organization — the age sweep's
 * input.
 *
 * Projection rather than the row, for the same reason
 * `UnsettledVerificationRecord` is: the sweep spans tenants and the counters
 * and the frozen-rule columns are not needed to decide *which* windows to
 * close, only to close them, which `SlaWindowService` does one row at a time
 * through the organization-scoped path once it has the id.
 */
export interface DueSlaWindow {
  readonly organizationId: string;
  readonly id: string;
}

/**
 * One provider's public quality counters, summed over their windows of the
 * last {@link PUBLIC_QUALITY_WINDOW_DAYS} days, open and closed.
 *
 * `verifiedCalls` is the denominator and `failedCalls` the numerator, exactly
 * as `sla_window_calls.counted_as_quality` / `counted_as_failure` define them —
 * this reads the per-window totals those flags were already folded into, rather
 * than re-deciding what counts. A provider with `verifiedCalls === 0` is not a
 * provider with perfect quality; it is one nothing has been measured on, and
 * the caller must render that difference.
 */
export interface ProviderQualityCounters {
  readonly providerId: string;
  readonly verifiedCalls: number;
  readonly failedCalls: number;
}

/**
 * `sla_windows`.
 *
 * Every finder here exists because `SlaWindowService.postCall` /
 * `closeWindow` / `sweepExpiredWindows` calls it — see that class for the
 * shape of the write path. The read side (`ProviderSlaWindowsService`) needs
 * no finder beyond the inherited scoped methods and its own
 * `createQueryBuilder` calls, including the deliberately cross-organization
 * peer-distribution query — see that service's own comment for why that one
 * is not here.
 */
@Injectable()
export class SlaWindowRepository extends OrganizationScopedRepository<SlaWindowEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(SlaWindowEntity, dataSource);
  }

  /**
   * The binding's open window in one settlement asset, if there is one.
   *
   * `uq_sla_windows_open` guarantees at most one row answers this per
   * (binding, asset) — the read half of the race `postCall` resolves on the
   * write side. Per asset because a window sums `price_amount` into
   * `total_call_amount` and prices its penalty in `asset_id`: a binding that
   * moves from one asset to another must not add two currencies together.
   */
  async findOpenForBinding(
    organizationId: string,
    bindingId: string,
    assetId: string,
  ): Promise<SlaWindowEntity | null> {
    return this.findOneBy({ organizationId, bindingId, assetId, status: OPEN });
  }

  /**
   * `1 + MAX(sequence)` for this binding, or `1` when it has never had a
   * window. The provider-facing `w_<sequence>` label a dispute is quoted by.
   */
  async nextSequence(organizationId: string, bindingId: string): Promise<number> {
    const row = await this.createQueryBuilder('window')
      .select('MAX(window.sequence)', 'maxSequence')
      .where('window.organizationId = :organizationId', { organizationId })
      .andWhere('window.bindingId = :bindingId', { bindingId })
      .getRawOne<{ maxSequence: string | null }>();

    const max =
      row?.maxSequence === null || row?.maxSequence === undefined ? 0 : Number(row.maxSequence);
    return max + 1;
  }

  /**
   * `total_calls`, `verified_calls`, `failed_calls`, `total_call_amount` — all
   * four in one `UPDATE`, in SQL, never a JS read-modify-write. Concurrent
   * `postCall`s on the same binding are the ordinary case (every verification
   * worker settling that binding's traffic), and a read-then-write here would
   * lose exactly the increments this table exists to count precisely.
   *
   * ## Why `status = 'OPEN'` is in the predicate
   *
   * `postCall` is not one transaction, so two workers can straddle the gate
   * crossing: A reads the window at 399 verified, increments to 400, and
   * closes it — computing a strike from exactly those counters — while B, which
   * read the same open window, increments afterwards. Without this clause B's
   * call lands in a window that has already been judged, and the `sla_strikes`
   * row then cites numbers that no longer match the `sla_windows` row it names.
   * A provider comparing the two in a dispute would find the platform's own
   * evidence disagreeing with itself, and the discrepancy would look exactly
   * like tampering.
   *
   * With the clause, a window's final counters are precisely the set it was
   * judged on. **The straddling call is then recorded in `sla_window_calls`
   * without being counted** — deliberate, and the conservative direction: the
   * row is the durable evidence that a call arrived after its window closed,
   * where discarding it would hide that fact. Returns the affected row count so
   * a caller can tell the two cases apart.
   */
  async incrementCounters(
    organizationId: string,
    id: string,
    input: {
      readonly countedAsQuality: boolean;
      readonly countedAsFailure: boolean;
      readonly priceAmount: string;
    },
  ): Promise<number> {
    const set: Record<string, unknown> = {
      totalCalls: () => '"total_calls" + 1',
      totalCallAmount: () => '"total_call_amount" + :priceAmount',
    };
    if (input.countedAsQuality) {
      set.verifiedCalls = () => '"verified_calls" + 1';
    }
    if (input.countedAsFailure) {
      set.failedCalls = () => '"failed_calls" + 1';
    }

    const result = await this.createQueryBuilder('window')
      .update()
      .set(set)
      .where('organization_id = :organizationId', { organizationId })
      .andWhere('id = :id', { id })
      .andWhere('status = :openStatus', { openStatus: OPEN })
      .setParameter('priceAmount', input.priceAmount)
      .execute();

    return result.affected ?? 0;
  }

  /**
   * `warning_level → level`, exactly once per level.
   *
   * The `IS DISTINCT FROM` guard is what makes two concurrent `postCall`s that
   * both compute the same new level notify only once: the first UPDATE moves
   * the column and returns one affected row, the second finds the column
   * already equal to `level` and affects zero — which `SlaWindowService` reads
   * as "someone else already told the provider this".
   */
  async stampWarningIfLower(
    organizationId: string,
    id: string,
    level: string,
    now: Date,
    isCritical: boolean,
  ): Promise<number> {
    const set: Record<string, unknown> = {
      warningLevel: level,
      warnedAt: () => 'COALESCE("warned_at", :now)',
    };
    if (isCritical) {
      set.criticalWarnedAt = now;
    }

    const result = await this.createQueryBuilder('window')
      .update()
      .set(set)
      .where('organization_id = :organizationId', { organizationId })
      .andWhere('id = :id', { id })
      .andWhere('warning_level IS DISTINCT FROM :level', { level })
      .setParameter('now', now)
      .execute();

    return result.affected ?? 0;
  }

  /**
   * `OPEN → CLOSED`, conditionally.
   *
   * The compare-and-swap `closeWindow` relies on: two callers racing to close
   * the same window (a `postCall` crossing the gate at the same instant the
   * sweep visits it) must produce exactly one `CLOSED` row and exactly one
   * strike attempt, not two. `uq_sla_strikes_window` is the backstop if this
   * ever raced anyway.
   */
  async closeIfOpen(
    organizationId: string,
    id: string,
    patch: {
      readonly outcome: string;
      readonly closedAt: Date;
      readonly samplingEscalationRequested: boolean;
    },
  ): Promise<number> {
    const criteria = { organizationId, id, status: OPEN };
    const values = {
      status: 'CLOSED',
      outcome: patch.outcome,
      closedAt: patch.closedAt,
      samplingEscalationRequested: patch.samplingEscalationRequested,
    };
    assertOrganizationScopedCriteria(criteria, 'SlaWindowRepository.closeIfOpen');
    const result = await this.update(criteria, values);
    return result.affected ?? 0;
  }

  /**
   * Public quality per provider, for the buyer-facing catalogue: every call
   * checked in the last {@link PUBLIC_QUALITY_WINDOW_DAYS} days.
   *
   * **Deliberately cross-organization**, and the sharpest instance of the
   * idiom in this file: the tenant on an `sla_windows` row is the **provider**
   * being measured, while the caller is a buyer who is by definition somebody
   * else. Scoping this to the caller's organization would not narrow the
   * answer, it would return nothing — the same shape
   * `ProviderVerificationService.getVerifications` already relies on to answer
   * "is this provider verified?" to a stranger.
   *
   * **`OPEN` and `CLOSED` windows alike** (owner decision D5, 2026-10-18). The
   * public figure used to sum closed windows only, and a provider whose open
   * windows held almost all of its traffic was shown by a handful of old
   * closed ones — "100% failed" beside a provider passing ~98% of its calls.
   * A buyer asks "how often does this fail now", so the figure covers the
   * windows still collecting: every `OPEN` window, plus every `CLOSED` window
   * that closed inside the period. Penalties are NOT computed here and do not
   * change: a strike and a slash still read a single closed window's frozen
   * counters (`SlaWindowService.closeWindow`), never this sum.
   *
   * The projection carries **no buyer identity and no window identity** — two
   * integers per provider and nothing else. A provider's window ids, deadlines
   * and strike history stay on their own console.
   *
   * Returns a row only for providers with at least one window in the period, so
   * an absent id means "not measured", never "measured at zero". The caller
   * must not fill the gap with a default.
   */
  async qualityByProvider(
    providerIds: readonly string[],
    now: Date = new Date(),
  ): Promise<ReadonlyMap<string, ProviderQualityCounters>> {
    if (providerIds.length === 0) return new Map();

    const since = new Date(now.getTime() - PUBLIC_QUALITY_WINDOW_DAYS * DAY_MS);
    const rows = await this.createQueryBuilder('window')
      .select('window.provider_id', 'providerId')
      .addSelect('COALESCE(SUM(window.verified_calls), 0)', 'verifiedCalls')
      .addSelect('COALESCE(SUM(window.failed_calls), 0)', 'failedCalls')
      .where('window.organizationId IS NOT NULL')
      .andWhere(
        '(window.status = :open OR (window.status = :closed AND window.closed_at >= :since))',
        { open: OPEN, closed: CLOSED, since },
      )
      .andWhere('window.provider_id IN (:...providerIds)', { providerIds })
      .groupBy('window.provider_id')
      .getRawMany<{ providerId: string; verifiedCalls: string; failedCalls: string }>();

    return new Map(
      rows.map((row) => [
        row.providerId,
        {
          providerId: row.providerId,
          verifiedCalls: Number(row.verifiedCalls),
          failedCalls: Number(row.failedCalls),
        },
      ]),
    );
  }

  /**
   * Every `OPEN` window past its `deadlineAt`, from any organization.
   *
   * **Deliberately cross-organization**, like `PaymentIntentRepository.
   * findDueForExpiry` and `VerificationRecordRepository.findUnsettled`: the
   * age sweep is a platform-level job with no calling tenant, run once by the
   * single-instance scheduler. `idx_sla_windows_deadline` is a partial index
   * on exactly this predicate, so the query stays the size of the open set.
   */
  async findDueForSweep(now: Date, limit: number): Promise<DueSlaWindow[]> {
    return this.manager
      .createQueryBuilder(SlaWindowEntity, 'window')
      .select('window.organization_id', 'organizationId')
      .addSelect('window.id', 'id')
      .where('window.status = :status', { status: OPEN })
      .andWhere('window.deadline_at <= :now', { now })
      .orderBy('window.deadline_at', 'ASC')
      .limit(limit)
      .getRawMany<DueSlaWindow>();
  }
}
