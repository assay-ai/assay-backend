import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LedgerHoldEntity } from '@database/postgres/entities/ledger-hold.entity';
import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { VerificationRecordEntity } from '@database/postgres/entities/verification-record.entity';
import { VerifierSigningLogEntryEntity } from '@database/postgres/entities/verifier-signing-log-entry.entity';

/**
 * The cross-organization aggregates behind the metrics endpoint,
 * following `PlatformMetricsRepository`'s own precedent exactly: a metrics
 * tile has no tenant, so every method here goes through
 * `this.dataSource.createQueryBuilder(Entity, alias)` rather than the
 * `OrganizationScopedRepository` those entities' own owning repositories
 * extend — the guard that class carries exists to catch a request-serving
 * query that *forgot* its tenant, and has no way to express "every tenant, on
 * purpose." See that repository's class doc for the full reasoning; it is
 * not repeated per method here.
 *
 * This repository owns no entity. It reads six tables that already have
 * owning repositories or entities elsewhere; every query is read-only.
 *
 * **No spec file for this class**, matching `PlatformMetricsRepository` —
 * neither has one in this codebase. The query-builder SQL is exercised
 * through `MetricsCollectorService`'s tests via a hand-written fake of this
 * repository, the same split `PlatformHealthService`'s tests use for
 * `PlatformMetricsRepository`.
 */
@Injectable()
export class ObservabilityMetricsRepository {
  constructor(@InjectDataSource('postgres') private readonly dataSource: DataSource) {}

  /**
   * `nonSystemError / total`, over PAID calls only, in the trailing window.
   *
   * `payment_intents.classification` is `SYSTEM_ERROR` | `REQUEST_ERROR` |
   * `DATA_RESULT` | ... (`ResponseClass`), set once classification runs; a
   * call still in flight has `classification IS NULL` and is excluded from
   * both sides of the fraction rather than counted as a failure it has not
   * had the chance to be.
   *
   * Free/freemium calls (`tool_call_records`) are not included — see the
   * `ObservabilitySignal.TOOL_CALL_SUCCESS_RATE` catalog entry.
   */
  async toolCallSuccessRate(since: Date): Promise<{ total: number; nonSystemError: number }> {
    const row = await this.dataSource
      .createQueryBuilder(PaymentIntentEntity, 'intent')
      .select('COUNT(*)::int', 'total')
      .addSelect(
        "COUNT(*) FILTER (WHERE intent.classification <> 'SYSTEM_ERROR')::int",
        'nonSystemError',
      )
      .where('intent.created_at >= :since', { since })
      .andWhere('intent.classification IS NOT NULL')
      .getRawOne<{ total: number; nonSystemError: number }>();

    return { total: row?.total ?? 0, nonSystemError: row?.nonSystemError ?? 0 };
  }

  /**
   * `FAIL / total`, per `(policy_id, policy_version)`, in the trailing window.
   *
   * This is the *raw* FAIL rate a policy is producing — distinct from
   * `PlatformHealthService`'s false-positive rate, which measures how many of
   * those FAILs were *wrong* against a labelled sample. A policy can have a
   * high, entirely correct FAIL rate (a genuinely unreliable provider) and a
   * low false-positive rate at the same time; conflating the two would hide
   * exactly that case.
   *
   * Rows with a `NULL` policy (no policy resolved, or the shadow-empty-result
   * path) are excluded — there is no policy to group them under.
   */
  async failRateByPolicy(
    since: Date,
  ): Promise<Array<{ policyId: string; policyVersion: number; total: number; fail: number }>> {
    const rows = await this.dataSource
      .createQueryBuilder(VerificationRecordEntity, 'record')
      .select('record.policy_id', 'policyId')
      .addSelect('record.policy_version', 'policyVersion')
      .addSelect('COUNT(*)::int', 'total')
      .addSelect("COUNT(*) FILTER (WHERE record.verdict_status = 'FAIL')::int", 'fail')
      .where('record.created_at >= :since', { since })
      .andWhere('record.policy_id IS NOT NULL')
      .andWhere('record.verdict_status IS NOT NULL')
      .groupBy('record.policy_id')
      .addGroupBy('record.policy_version')
      .getRawMany<{ policyId: string; policyVersion: number; total: number; fail: number }>();

    return rows;
  }

  /**
   * The verification-settlement lag: `settled_at − created_at`, p95, over
   * records settled in the trailing window.
   *
   * An *approximation* of the golden signal "`VERIFYING` → terminal, p95" — that
   * transition lives on `payment_intents.status` and carries no timestamp
   * pair of its own. `verification_records.created_at` is written at the
   * same call (see `VerificationRecordEntity`'s own docstring: the record is
   * opened once, right after the intent enters `VERIFYING`) and `settled_at`
   * is stamped when the settlement instruction is decided — see
   * `SIGNAL_CATALOG` for why this is documented as an approximation rather
   * than presented as the signal's own number.
   *
   * `PERCENTILE_CONT` over an empty set is `NULL` — the same "null when
   * nothing settled, never a fabricated 0" rule `PlatformMetricsRepository`
   * uses.
   */
  async settlementLagP95Seconds(since: Date): Promise<number | null> {
    const row = await this.dataSource
      .createQueryBuilder(VerificationRecordEntity, 'record')
      .select(
        'PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (record.settled_at - record.created_at)))::float8',
        'p95Seconds',
      )
      .where('record.settled_at IS NOT NULL')
      .andWhere('record.settled_at >= :since', { since })
      .getRawOne<{ p95Seconds: number | string | null }>();

    return toFiniteNumberOrNull(row?.p95Seconds);
  }

  /**
   * The oldest still-`OPEN` hold's age, in seconds, and how many are open.
   *
   * Golden-signal threshold: "Page > 1h" — an open hold is money
   * already reserved against an agent's balance and not yet resolved either
   * way (settled or released), so its age is what `OPEN_HOLD_AGE_MS` grades.
   * `null` when nothing is open, not `0` — an empty queue has no oldest
   * member, and `0` would read as "one just opened."
   */
  async openHoldAge(now: Date): Promise<{ count: number; oldestAgeSeconds: number | null }> {
    const row = await this.dataSource
      .createQueryBuilder(LedgerHoldEntity, 'hold')
      .select('COUNT(*)::int', 'count')
      .addSelect(
        'EXTRACT(EPOCH FROM (:now::timestamptz - MIN(hold.created_at)))::float8',
        'oldestAgeSeconds',
      )
      .where("hold.status = 'OPEN'")
      .setParameter('now', now)
      .getRawOne<{ count: number; oldestAgeSeconds: number | string | null }>();

    return {
      count: row?.count ?? 0,
      oldestAgeSeconds: toFiniteNumberOrNull(row?.oldestAgeSeconds),
    };
  }

  /**
   * Signatures produced in the trailing window (`SIGNED` and `ATTEMPTED` —
   * see `producedSignature` in `signing-journal.ts`: a crash between opening
   * an attempt and settling it is read as "probably signed," the conservative
   * direction for a security-relevant count).
   */
  async attestationsSigned(since: Date): Promise<number> {
    const row = await this.dataSource
      .createQueryBuilder(VerifierSigningLogEntryEntity, 'entry')
      .select('COUNT(*)::int', 'count')
      .where("entry.outcome IN ('SIGNED', 'ATTEMPTED')")
      .andWhere('entry.created_at >= :since', { since })
      .getRawOne<{ count: number }>();

    return row?.count ?? 0;
  }

  /**
   * Slash proposals that reached `EXECUTED` in the trailing window.
   *
   * Windowed on `updated_at`, not `proposed_at` — see `SIGNAL_CATALOG` for
   * why this is a proxy: the table has no dedicated `executed_at`, and
   * `applied_amount` (the field that is genuinely null-until-executed) has no
   * timestamp of its own either. `updated_at` is the row's last write, which
   * for a row currently in `EXECUTED` is expected to be the transition into
   * it — `SlashExecutionService` writes status once per transition, never
   * touches an already-`EXECUTED` row again.
   */
  async slashesExecuted(since: Date): Promise<number> {
    const row = await this.dataSource
      .createQueryBuilder(SlashProposalEntity, 'proposal')
      .select('COUNT(*)::int', 'count')
      .where("proposal.status = 'EXECUTED'")
      .andWhere('proposal.updated_at >= :since', { since })
      .getRawOne<{ count: number }>();

    return row?.count ?? 0;
  }
}

/**
 * Same normalisation as `PlatformMetricsRepository`'s own helper: `pg`'s type
 * parser can hand back a `double precision` as a string, and `NULL`/`NaN`
 * both become `null`, never a fabricated `0`.
 */
function toFiniteNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
