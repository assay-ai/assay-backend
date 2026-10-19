import { Injectable, Logger } from '@nestjs/common';

import { ReconciliationRunRepository } from '@database/postgres/repositories/reconciliation-run.repository';
import { PlatformMetricsRepository } from '@database/postgres/repositories/platform-metrics.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import {
  AlertSeverity,
  evaluateGoldenSignal,
  evaluateReserveHealth,
  GoldenSignal,
} from '@shared/alerting';

import { atomicToDisplayNumber } from '../domain/money-scale';
import { ObservabilitySignal, SIGNAL_CATALOG, SignalAvailability } from '../domain/signal-catalog';
import { ObservabilityMetricsRepository } from '../repositories/observability-metrics.repository';
import {
  gateCimdBlockedAddress,
  gateContinueCookieMissing,
  gateDcrRegistrations,
  gateGrantsStoppedForReuse,
  gateLiveGrantsPerAgent,
} from '../domain/oauth-signal-gates';
import { OAuthSignalFigures, OAuthSignalsReader } from './oauth-signals.reader';
import {
  MetricsSnapshotDto,
  PolicyFailRateRowDto,
  ReconciliationAssetRowDto,
  SignalGateDto,
  SignalReadingDto,
  SignalSection,
} from '../dto/metrics-snapshot.dto';

/**
 * How long a computed snapshot is reused before the next `/operator/dashboard`
 * request triggers a fresh round of queries.
 *
 * ## Why this exists at all
 *
 * `PlatformMetricsRepository.intentRateCounts`'s own docstring: `payment_intents`
 * has no index on `created_at` alone, so that query is "acceptable at
 * dashboard cadence" — and every query this module adds
 * (`ObservabilityMetricsRepository`) reads a `created_at`/`disputed_at`/
 * `updated_at` window the same way, on tables carrying the same caveat or
 * worse (none of the six have a dedicated time-range index for these
 * queries). Every collector in this file is cached behind one shared refresh,
 * so an operator hitting `/operator/dashboard` in a loop costs at most one
 * round of these queries per TTL.
 *
 * Default **30 seconds** — half the reconciler's own 5-minute cadence's
 * order of magnitude tighter bound, and in line with `PlatformHealthService`'s
 * console tiles, which nothing today caches at all (this module's queries are
 * a strict superset of those, so 30s is the more conservative choice, not a
 * new risk). Override with `OBSERVABILITY_METRICS_CACHE_TTL_MS`. Read inline
 * rather than through `ConfigModule`, matching `isEgressLockdownEnabled()`'s
 * own reasoning: this file must not gain a dependency on module wiring it
 * does not own.
 */
function cacheTtlMs(): number {
  const configured = Number(process.env.OBSERVABILITY_METRICS_CACHE_TTL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 30_000;
}

/** Trailing windows for the rate/count signals. Named so every call site says which it used. */
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour — tool-call success, FAIL rate by policy
const SETTLEMENT_WINDOW_MS = 60 * 60 * 1000; // 1 hour — settlement lag
const OVERTURN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — matches PlatformHealthService
const ATTESTATION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const SLASH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

@Injectable()
export class MetricsCollectorService {
  private readonly logger = new Logger(MetricsCollectorService.name);
  private cached: { snapshot: MetricsSnapshotDto; refreshedAt: number } | null = null;
  /** Serialises concurrent refreshes so two requests racing a cold cache do not double the query load. */
  private inFlight: Promise<MetricsSnapshotDto> | null = null;

  constructor(
    private readonly reconciliationRuns: ReconciliationRunRepository,
    private readonly platformMetrics: PlatformMetricsRepository,
    private readonly slashProposals: SlashProposalRepository,
    private readonly observability: ObservabilityMetricsRepository,
    private readonly oauthSignals: OAuthSignalsReader,
  ) {}

  /** The JSON snapshot behind `GET /operator/dashboard` and its data endpoint. */
  async snapshot(): Promise<MetricsSnapshotDto> {
    const now = Date.now();
    if (this.cached && now - this.cached.refreshedAt < cacheTtlMs()) {
      return this.cached.snapshot;
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.refresh(now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async refresh(now: number): Promise<MetricsSnapshotDto> {
    const nowDate = new Date(now);
    const [
      reconciliationRuns,
      falsePositive,
      toolCalls,
      failByPolicy,
      settlementLagP95,
      openHold,
      attestations,
      slashes,
      queue,
      intentRates,
      disputeOverturn,
      oauth,
    ] = await Promise.all([
      this.reconciliationRuns.findLatestPerAsset(),
      this.slashProposals.falsePositiveCounts(new Date(now - OVERTURN_WINDOW_MS)),
      this.observability.toolCallSuccessRate(new Date(now - RATE_WINDOW_MS)),
      this.observability.failRateByPolicy(new Date(now - RATE_WINDOW_MS)),
      this.observability.settlementLagP95Seconds(new Date(now - SETTLEMENT_WINDOW_MS)),
      this.observability.openHoldAge(nowDate),
      this.observability.attestationsSigned(new Date(now - ATTESTATION_WINDOW_MS)),
      this.observability.slashesExecuted(new Date(now - SLASH_WINDOW_MS)),
      this.platformMetrics.verificationBacklog(nowDate),
      this.platformMetrics.intentRateCounts(nowDate),
      this.observability.disputeOverturnCounts(new Date(now - OVERTURN_WINDOW_MS)),
      // Never rejects: a failed OAuth source reads as absent (see the reader).
      this.oauthSignals.read(now),
    ]).catch((error: unknown) => {
      // Log and rethrow: the caller falls back to the last good snapshot (or
      // an all-absent one on a cold start).
      this.logger.error(`Metrics refresh failed: ${describe(error)}`);
      throw error;
    });

    const reconciliation = reconciliationRuns.map((run) => this.reconciliationRow(run));
    const failRateByPolicy = failByPolicy.map((row) => this.policyFailRow(row));

    const toolCallSuccessRate =
      toolCalls.total > 0 ? toolCalls.nonSystemError / toolCalls.total : null;
    const falsePositiveRate =
      falsePositive.resolved > 0 ? falsePositive.falsePositives / falsePositive.resolved : null;
    const disputeOverturnRate =
      disputeOverturn.raised > 0 ? disputeOverturn.overturned / disputeOverturn.raised : null;

    const signals: SignalReadingDto[] = [
      this.reading(
        ObservabilitySignal.FALSE_POSITIVE_RATE,
        'other',
        falsePositiveRate,
        'ratio',
        null,
      ),
      this.reading(ObservabilitySignal.FALSE_NEGATIVE_RATE, 'other', null, 'ratio', null),
      this.reading(
        ObservabilitySignal.DISPUTE_OVERTURN_RATE,
        'money',
        disputeOverturnRate,
        'ratio',
        disputeOverturnRate === null
          ? null
          : toGate(evaluateGoldenSignal(GoldenSignal.DISPUTE_OVERTURN_RATE, disputeOverturnRate)),
      ),
      this.reading(ObservabilitySignal.GAS_RUNWAY_DAYS, 'money', null, 'days', null),
      this.reading(
        ObservabilitySignal.TOOL_CALL_SUCCESS_RATE,
        'traffic',
        toolCallSuccessRate,
        'ratio',
        toolCallSuccessRate === null
          ? null
          : toGate(evaluateGoldenSignal(GoldenSignal.TOOL_CALL_SUCCESS_RATE, toolCallSuccessRate)),
      ),
      this.reading(
        ObservabilitySignal.PLATFORM_LATENCY_P95_BY_BINDING,
        'traffic',
        null,
        'ms',
        null,
      ),
      this.reading(
        ObservabilitySignal.SETTLEMENT_LAG_P95,
        'other',
        settlementLagP95,
        'seconds',
        settlementLagP95 === null
          ? null
          : toGate(
              evaluateGoldenSignal(GoldenSignal.SETTLEMENT_LAG_P95_MS, settlementLagP95 * 1000),
            ),
      ),
      this.reading(ObservabilitySignal.PAYOUT_LAG_P95, 'money', null, 'seconds', null),
      this.reading(
        ObservabilitySignal.OPEN_HOLD_AGE,
        'money',
        openHold.oldestAgeSeconds,
        'seconds',
        openHold.oldestAgeSeconds === null
          ? null
          : toGate(
              evaluateGoldenSignal(GoldenSignal.OPEN_HOLD_AGE_MS, openHold.oldestAgeSeconds * 1000),
            ),
        { openHoldCount: openHold.count },
      ),
      this.reading(
        ObservabilitySignal.ATTESTATIONS_SIGNED,
        'money',
        attestations,
        'count / 24h',
        null,
      ),
      this.reading(ObservabilitySignal.SLASH_COUNT, 'money', slashes, 'count / 30d', null),
      this.reading(
        ObservabilitySignal.VERIFICATION_QUEUE_DEPTH,
        'traffic',
        queue.count,
        'records',
        null,
        {
          p95AgeSeconds: queue.p95AgeSeconds ?? undefined,
        },
      ),
      this.reading(ObservabilitySignal.EGRESS_BLOCKS, 'traffic', null, 'count', null),
    ];

    // Bonus readings shown on the dashboards but not part of the
    // named-signals ∪ golden-signals union — see the class comment on
    // `SIGNAL_CATALOG`. Kept out of that enum on purpose: it is the contract
    // for the union list specifically, and this one is extra.
    const bonus: SignalReadingDto[] = [
      {
        signal: 'INTENTS_PER_MINUTE',
        label: 'Calls (intents / minute)',
        section: 'traffic',
        availability: SignalAvailability.SOURCED,
        value: intentRates.lastMinute,
        unit: 'count / min',
        gate: null,
        reason: null,
      },
    ];

    const generatedSnapshot: MetricsSnapshotDto = {
      generatedAt: nowDate.toISOString(),
      cacheTtlMs: cacheTtlMs(),
      reconciliation,
      failRateByPolicy,
      signals: [...signals, ...bonus, ...this.oauthReadings(oauth)],
    };

    this.cached = { snapshot: generatedSnapshot, refreshedAt: now };
    return generatedSnapshot;
  }

  /**
   * The OAuth signals (spec §6.7). A source that could not be read leaves its
   * rows with a null value and no gate, never a zero.
   */
  private oauthReadings({ database: db, counters }: OAuthSignalFigures): SignalReadingDto[] {
    const day = counters?.last24h ?? null;
    const sum = (values: Record<string, number> | undefined): number | null =>
      values ? Object.values(values).reduce((total, value) => total + value, 0) : null;
    // Absent, not `{}`, when the source failed: an empty object would read as
    // "nothing happened" next to the null value.
    const nonZero = (values: Record<string, number> | undefined) =>
      values
        ? Object.fromEntries(Object.entries(values).filter(([, value]) => value > 0))
        : undefined;
    const gate = <T>(input: T | null | undefined, evaluate: (value: T) => GateInput) =>
      input === null || input === undefined ? null : toGate(evaluate(input));

    const stopped = db ? db.stoppedForRefreshReuse + db.stoppedForCodeReuse : null;
    const missing = counters?.lastHour.continueCookieMissing ?? null;

    const readings = [
      this.reading(
        ObservabilitySignal.OAUTH_LIVE_GRANTS,
        'oauth',
        db?.liveGrants ?? null,
        'grants',
        null,
      ),
      this.reading(
        ObservabilitySignal.OAUTH_LIVE_GRANTS_PER_AGENT_MAX,
        'oauth',
        db?.maxLiveGrantsPerAgent ?? null,
        'grants',
        gate(db?.maxLiveGrantsPerAgent, gateLiveGrantsPerAgent),
      ),
      this.reading(
        ObservabilitySignal.OAUTH_GRANTS_STOPPED_FOR_REUSE,
        'oauth',
        stopped,
        'count / 24h',
        gate(stopped, gateGrantsStoppedForReuse),
        db
          ? { refreshReuse: db.stoppedForRefreshReuse, codeReuse: db.stoppedForCodeReuse }
          : undefined,
      ),
      this.reading(
        ObservabilitySignal.OAUTH_REFRESH_STALE_REUSE,
        'oauth',
        db?.refreshStaleReuse ?? null,
        'count / 24h',
        null,
      ),
      this.reading(
        ObservabilitySignal.OAUTH_REFRESH_GRACE_USES,
        'oauth',
        db?.refreshGraceUses ?? null,
        'count / 24h',
        null,
      ),
      this.reading(
        ObservabilitySignal.OAUTH_DCR_REGISTRATIONS,
        'oauth',
        db?.dcrRegistrations ?? null,
        'count / 24h',
        gate(db, (facts) =>
          gateDcrRegistrations(facts.dcrRegistrations, facts.dcrMaxPerClientName),
        ),
        db ? { maxPerClientName: db.dcrMaxPerClientName } : undefined,
      ),
      this.reading(
        ObservabilitySignal.OAUTH_CIMD_CLIENTS,
        'oauth',
        db?.cimdClients ?? null,
        'clients',
        null,
      ),
      this.reading(
        ObservabilitySignal.OAUTH_TOKEN_RESULTS,
        'oauth',
        sum(day?.token),
        'count / 24h',
        null,
        nonZero(day?.token),
      ),
      this.reading(
        ObservabilitySignal.OAUTH_CONSENT_STEPS,
        'oauth',
        day?.consent.approved ?? null,
        'count / 24h',
        null,
        nonZero(day?.consent),
      ),
      this.reading(
        ObservabilitySignal.OAUTH_CONTINUE_COOKIE_MISSING,
        'oauth',
        missing,
        'count / 1h',
        gate(counters?.lastHour, (hour) =>
          gateContinueCookieMissing(hour.continueCookieMissing, hour.consentApproved),
        ),
        counters
          ? {
              approvedLastHour: counters.lastHour.consentApproved,
              missingLast24h: counters.last24h.consent.continue_cookie_missing,
            }
          : undefined,
      ),
      this.reading(
        ObservabilitySignal.OAUTH_AUTHORIZE_OUTCOMES,
        'oauth',
        day?.authorize.stored ?? null,
        'count / 24h',
        null,
        nonZero(day?.authorize),
      ),
      this.reading(
        ObservabilitySignal.OAUTH_CIMD_FETCHES,
        'oauth',
        sum(day?.cimd_fetch),
        'count / 24h',
        gate(day?.cimd_fetch.blocked_address, gateCimdBlockedAddress),
        nonZero(day?.cimd_fetch),
      ),
      this.reading(
        ObservabilitySignal.MCP_UNAUTHORIZED,
        'oauth',
        sum(day?.mcp_unauthorized),
        'count / 24h',
        null,
        nonZero(day?.mcp_unauthorized),
      ),
    ];

    // A source that failed or timed out: say so, rather than the catalogue's
    // description of where the number would have come from.
    const unavailable = new Set<string>([
      ...(db ? [] : OAUTH_DATABASE_SIGNALS),
      ...(counters ? [] : OAUTH_COUNTER_SIGNALS),
    ]);
    return readings.map((reading) =>
      unavailable.has(reading.signal) ? { ...reading, reason: OAUTH_SOURCE_UNAVAILABLE } : reading,
    );
  }

  private reconciliationRow(run: {
    assetId: string;
    decimals: number;
    difference: string | null;
    severity: string;
    startedAt: Date;
  }): ReconciliationAssetRowDto {
    const ageSeconds = Math.max(0, (Date.now() - run.startedAt.getTime()) / 1000);
    const gate =
      run.difference === null ? null : toGate(evaluateReserveHealth(BigInt(run.difference)));

    return {
      asset: run.assetId,
      differenceDisplay:
        run.difference === null ? null : atomicToDisplayNumber(run.difference, run.decimals),
      severity: run.severity,
      ageSeconds,
      gate,
    };
  }

  private policyFailRow(row: {
    policyId: string;
    policyVersion: number;
    total: number;
    fail: number;
  }): PolicyFailRateRowDto {
    return {
      policyId: row.policyId,
      policyVersion: row.policyVersion,
      total: row.total,
      failRate: row.total > 0 ? row.fail / row.total : 0,
    };
  }

  private reading(
    signal: ObservabilitySignal,
    section: SignalSection,
    value: number | null,
    unit: string,
    gate: SignalGateDto | null,
    extra?: Record<string, number | undefined>,
  ): SignalReadingDto {
    const descriptor = SIGNAL_CATALOG[signal];
    return {
      signal,
      label: descriptor.label,
      section,
      availability: descriptor.availability,
      value: descriptor.availability === SignalAvailability.NONE ? null : value,
      unit,
      gate,
      reason: descriptor.reason ?? null,
      extra,
    };
  }
}

const OAUTH_SOURCE_UNAVAILABLE =
  'Source unavailable: the read failed or did not answer within 1 s. Not zero.';

const OAUTH_DATABASE_SIGNALS: readonly string[] = [
  ObservabilitySignal.OAUTH_LIVE_GRANTS,
  ObservabilitySignal.OAUTH_LIVE_GRANTS_PER_AGENT_MAX,
  ObservabilitySignal.OAUTH_GRANTS_STOPPED_FOR_REUSE,
  ObservabilitySignal.OAUTH_REFRESH_STALE_REUSE,
  ObservabilitySignal.OAUTH_REFRESH_GRACE_USES,
  ObservabilitySignal.OAUTH_DCR_REGISTRATIONS,
  ObservabilitySignal.OAUTH_CIMD_CLIENTS,
];

const OAUTH_COUNTER_SIGNALS: readonly string[] = [
  ObservabilitySignal.OAUTH_TOKEN_RESULTS,
  ObservabilitySignal.OAUTH_CONSENT_STEPS,
  ObservabilitySignal.OAUTH_CONTINUE_COOKIE_MISSING,
  ObservabilitySignal.OAUTH_AUTHORIZE_OUTCOMES,
  ObservabilitySignal.OAUTH_CIMD_FETCHES,
  ObservabilitySignal.MCP_UNAUTHORIZED,
];

type GateInput = { severity: AlertSeverity; summary: string } | null;

function toGate(alert: GateInput): SignalGateDto {
  if (!alert) {
    return { status: 'OK', summary: 'Within the configured threshold.' };
  }
  return {
    status: alert.severity === AlertSeverity.CRITICAL ? 'CRITICAL' : 'WARN',
    summary: alert.summary,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
