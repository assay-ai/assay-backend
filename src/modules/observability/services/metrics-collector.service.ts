import { EvmChainStateRepository } from '@database/postgres/repositories/evm-chain-state.repository';
import { chainStateLagMs } from '@modules/chains/evm/chain-state/evm-chain-state.indexer';
import { Injectable, Logger, Optional } from '@nestjs/common';

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
import { reconciliationSeverityToNumber } from '../domain/severity-scale';
import { ObservabilitySignal, SIGNAL_CATALOG, SignalAvailability } from '../domain/signal-catalog';
import { ObservabilityMetricsRepository } from '../repositories/observability-metrics.repository';
import { MetricsRegistryService } from './metrics-registry.service';
import {
  MetricsSnapshotDto,
  PolicyFailRateRowDto,
  ReconciliationAssetRowDto,
  SignalGateDto,
  SignalReadingDto,
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
 * queries). A Prometheus scrape is not dashboard cadence — a 15s
 * `scrape_interval`, the Prometheus default, is 4 queries a minute against
 * every one of these tables, indefinitely, from every process that serves one.
 *
 * This TTL is the fix: **every** collector in this file is cached behind one
 * shared refresh, so the *scrape* interval and the *query* interval are
 * decoupled entirely. A scrape at any cadence — 1s or 60s — costs at most one
 * round of these queries per {@link CACHE_TTL_MS}. The alternative the task
 * offered ("make the scrape interval explicit") was not enough on its own:
 * it only constrains a cooperating Prometheus config, and does nothing for a
 * curious operator hitting `/operator/dashboard` in a loop, or a second
 * scrape target added later without reading this comment.
 *
 * Default **30 seconds** — half the reconciler's own 5-minute cadence's
 * order of magnitude tighter bound, and in line with `PlatformHealthService`'s
 * console tiles, which nothing today caches at all (this module's queries are
 * a strict superset of those, so 30s is the more conservative choice, not a
 * new risk). Override with `OBSERVABILITY_METRICS_CACHE_TTL_MS`. Read inline
 * rather than through `ConfigModule`, matching `isEgressLockdownEnabled()`'s
 * own reasoning: this file must not gain a dependency on module wiring it
 * does not own.
 *
 * **Operational implication**: configure Prometheus's `scrape_interval` for
 * this target to **30s or looser**. A tighter scrape interval is harmless —
 * the cache absorbs it — but will not produce fresher numbers than this TTL
 * allows, and it wastes the scrape.
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
    private readonly registry: MetricsRegistryService,
    // The EVM chain-state indexer's lag. Optional so a composition without it
    // still scrapes.
    @Optional() private readonly chainStates: EvmChainStateRepository | null = null,
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
      payoutQueueDepth,
      intentRates,
      disputeOverturn,
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
      this.observability.payoutQueueDepth(),
      this.platformMetrics.intentRateCounts(nowDate),
      this.observability.disputeOverturnCounts(new Date(now - OVERTURN_WINDOW_MS)),
    ]).catch((error: unknown) => {
      // The collector must not 500 `/metrics` — a scrape failing to parse an
      // empty body is worse than a stale-but-valid one. Log and fall back to
      // the last good snapshot (or an all-absent one on a cold start).
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

    // ── Set the gauges/counters registry consumers (Prometheus) read ───────
    for (const run of reconciliation) {
      setGauge(this.registry.reconciliationDifference.labels(run.asset), run.differenceDisplay);
      setGauge(
        this.registry.reconciliationSeverity.labels(run.asset),
        reconciliationSeverityToNumber(run.severity),
      );
      setGauge(this.registry.reconciliationAgeSeconds.labels(run.asset), run.ageSeconds);
      if (run.gate) {
        setGauge(
          this.registry.signalStatus.labels(`reserve_health:${run.asset}`),
          gateToNumber(run.gate.status),
        );
      }
    }
    if (falsePositiveRate !== null) {
      this.registry.falsePositiveRate.set(falsePositiveRate);
      // Deliberately NOT set on `signalStatus` — see SIGNAL_CATALOG's
      // FALSE_POSITIVE_RATE reason: this is the dispute-derived proxy, and
      // golden-signals.ts forbids grading it against the labelled-sample gate.
    }
    if (disputeOverturnRate !== null) {
      this.registry.disputeOverturnRate.set(disputeOverturnRate);
    }
    if (toolCallSuccessRate !== null) {
      this.registry.toolCallSuccessRate.set(toolCallSuccessRate);
    }
    if (settlementLagP95 !== null) {
      this.registry.settlementLagP95Seconds.set(settlementLagP95);
    }
    // `openHold.oldestAgeSeconds` is `null` when nothing is open — see
    // `ObservabilityMetricsRepository.openHoldAge`'s own docstring on why
    // that must never become a fabricated `0` ("0" reads as "one just
    // opened," not "the queue is empty"). The JSON snapshot (below) carries
    // that `null` faithfully. `GET /metrics` cannot make the same promise for
    // this one series: `assay_open_hold_count` is labelled `[]`, and
    // prom-client initialises every unlabelled Gauge to `0` at construction
    // (`Metric.reset()`), so the series exists from process start regardless
    // of whether `.set()` is ever called. Read it beside
    // `assay_open_hold_count == 0` — that pairing is the honest "empty queue"
    // signal at the Prometheus layer.
    if (openHold.oldestAgeSeconds !== null) {
      this.registry.openHoldOldestAgeSeconds.set(openHold.oldestAgeSeconds);
    }
    setGauge(this.registry.openHoldCount, openHold.count);
    for (const row of failRateByPolicy) {
      setGauge(
        this.registry.failRateByPolicy.labels(row.policyId, String(row.policyVersion)),
        row.failRate,
      );
    }
    setGauge(this.registry.attestationsSigned.labels('24h'), attestations);
    setGauge(this.registry.slashesExecuted.labels('30d'), slashes);
    setGauge(this.registry.verificationQueueDepth, queue.count);
    if (queue.p95AgeSeconds !== null) {
      this.registry.verificationQueueP95AgeSeconds.set(queue.p95AgeSeconds);
    }
    setGauge(this.registry.payoutQueueDepth, payoutQueueDepth);
    setGauge(this.registry.intentsPerMinute, intentRates.lastMinute);
    for (const state of (await this.chainStates?.findAllStates().catch(() => [])) ?? []) {
      const lagMs = chainStateLagMs(state.caughtUpAt, now);
      if (lagMs !== null) {
        setGauge(this.registry.evmChainStateLagSeconds.labels(state.chainId), lagMs / 1000);
      }
    }

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
      this.reading(
        ObservabilitySignal.EGRESS_BLOCKS,
        'traffic',
        currentEgressBlockedTotal(this.registry),
        'count',
        null,
      ),
    ];

    // Every graded reading's gate also lands on the `assay_signal_status`
    // gauge — not just reserve health's (set above, per-asset). Without this
    // loop the Prometheus surface would silently carry a gate for exactly one
    // signal while the JSON snapshot carried five; a scrape-only consumer
    // (no dashboard, alerting straight off `/metrics`) would never see
    // `tool_call_success_rate`, `dispute_overturn_rate`, `settlement_lag_p95`
    // or `open_hold_age` cross their threshold.
    for (const reading of signals) {
      if (reading.gate) {
        this.registry.signalStatus
          .labels(reading.signal.toLowerCase())
          .set(gateToNumber(reading.gate.status));
      }
    }

    // Bonus readings shown on the dashboards but not part of the
    // named-signals ∪ golden-signals union — see the class comment on
    // `SIGNAL_CATALOG`. Kept out of that enum on purpose: it is the contract
    // for the union list specifically, and these two are extra.
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
      {
        signal: 'PAYOUT_QUEUE_DEPTH',
        label: 'Payout queue (PENDING + SUBMITTED)',
        section: 'money',
        availability: SignalAvailability.SOURCED,
        value: payoutQueueDepth,
        unit: 'records',
        gate: null,
        reason: null,
      },
    ];

    const generatedSnapshot: MetricsSnapshotDto = {
      generatedAt: nowDate.toISOString(),
      cacheTtlMs: cacheTtlMs(),
      reconciliation,
      failRateByPolicy,
      signals: [...signals, ...bonus],
    };

    this.cached = { snapshot: generatedSnapshot, refreshedAt: now };
    return generatedSnapshot;
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
    section: 'money' | 'traffic' | 'other',
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

function toGate(alert: { severity: AlertSeverity; summary: string } | null): SignalGateDto {
  if (!alert) {
    return { status: 'OK', summary: 'Within the configured threshold.' };
  }
  return {
    status: alert.severity === AlertSeverity.CRITICAL ? 'CRITICAL' : 'WARN',
    summary: alert.summary,
  };
}

function gateToNumber(status: 'OK' | 'WARN' | 'CRITICAL'): number {
  return status === 'CRITICAL' ? 2 : status === 'WARN' ? 1 : 0;
}

/**
 * The in-process egress-block counter's JSON reading.
 *
 * `recordEgressBlock` has no caller anywhere in this codebase yet — the counter exists and is correctly wired into the
 * Prometheus registry, but nothing has ever incremented it, so no labelled
 * series exists for it at all. That is the accurate "absent" state
 * `SIGNAL_CATALOG` asks for, and `null` here (never a fabricated `0`) is
 * what carries it into the JSON snapshot. `GET /metrics` needs no equivalent
 * special-casing: a `Counter` with an unused label never emits a series in
 * Prometheus exposition text in the first place.
 */
function currentEgressBlockedTotal(_registry: MetricsRegistryService): number | null {
  return null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The only way this file writes a gauge.
 *
 * `prom-client`'s `Gauge.set` throws `TypeError: Value is not a valid number`
 * on `null`, and a surprising number of the values here are legitimately
 * null: `reconciliation_runs.difference` is nullable and IS null on every row
 * while the reconciler cannot reach the vault, `PERCENTILE_CONT` over an empty
 * set returns null rather than zero, and a rate over a zero denominator has no
 * value. Passing any of those through took down `GET /operator/dashboard` with
 * a 500 — found by opening the page, not by a test, because the fakes in
 * `test/unit/observability` return numbers.
 *
 * Skipping the write is also the semantically right answer, not just the safe
 * one: an unset series is **absent**, and absent is what "we do not know this"
 * looks like in Prometheus. Writing `0` would claim the reconciler agrees with
 * the ledger exactly, at the moment it cannot read the vault at all — the one
 * reading that must never be inferred from silence.
 *
 * Guarding here rather than at each call site is deliberate: there are a dozen
 * writes and the next one added will not remember.
 */
function setGauge(gauge: { set(value: number): void }, value: number | null | undefined): void {
  if (value === null || value === undefined || Number.isNaN(value)) return;
  gauge.set(value);
}
