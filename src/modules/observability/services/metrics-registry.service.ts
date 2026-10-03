import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * The metrics surface: every Counter/Gauge/Histogram this codebase
 * exposes at `GET /metrics`, and the two recording methods a call site
 * elsewhere in the codebase would call to feed the in-process instruments.
 *
 * ## Its own `Registry`, never `prom-client`'s default
 *
 * `prom-client`'s default registry (`register` exported from the package
 * root) is a **process-global singleton** — registering a metric with the
 * same name against it twice throws, which is exactly what happens the
 * moment a second `TestingModule` (or a second `new MetricsRegistryService()`
 * in a hand-rolled unit test, this codebase's own house style — see
 * `test/unit/observability/`) constructs this class in the same Jest worker.
 * Every metric below is created with `registers: [this.registry]` against an
 * instance field, so each `MetricsRegistryService` owns a private
 * `Registry` and constructing two of them in one process is always safe —
 * the alternative this class deliberately did not take is clearing the
 * default registry between tests, which is a global mutation any other spec
 * running in the same worker would also feel.
 *
 * ## Gauges vs Counters vs Histograms, and why
 *
 * The DB-backed figures ({@link setReconciliation} and friends) are
 * `Gauge`s, not `Counter`s, even where the underlying quantity — a count of
 * rows — sounds monotonic: every one of them is a **windowed** count
 * (`attestationsSigned` in the trailing 24h, `slashesExecuted` in the
 * trailing 30d) or a **point-in-time** read (reconciliation difference, open
 * hold age), and both can go *down* between scrapes as the window rolls or
 * the underlying condition clears. A Prometheus `Counter` that decreases is a
 * contract violation `rate()` assumes never happens; a `Gauge` makes no such
 * promise and is the correct primitive for "recomputed by a query," full
 * stop.
 *
 * Only the two truly event-driven, in-process signals —
 * {@link recordEgressBlock} and {@link observePlatformLatency} — are a
 * `Counter`/`Histogram`. Both are append-only for the life of the process by
 * construction (an egress block either happened or it did not; a latency
 * observation is one more sample), which is the actual definition a
 * Prometheus `Counter`/`Histogram` requires. Neither has a caller in this
 * codebase yet — see `SIGNAL_CATALOG`'s `AWAITING_INSTRUMENTATION` entries.
 */
@Injectable()
export class MetricsRegistryService {
  readonly registry = new Registry();

  // ── In-process instruments (awaiting a wiring line elsewhere) ────────────

  private readonly egressBlockedTotal = new Counter({
    name: 'x402_egress_blocked_total',
    help: 'Outbound calls refused by the egress SSRF guard (EgressFailureKind.BLOCKED_ADDRESS), by reason.',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  private readonly platformAddedLatencyMs = new Histogram({
    name: 'x402_platform_added_latency_ms',
    help:
      'Platform-added time per tool call, excluding provider_call — resolve_tool + verify_voucher + ' +
      'ledger_hold + select_provider + classify_response + return_to_agent. Warn above 25ms.',
    labelNames: ['bindingId'] as const,
    buckets: [1, 2, 5, 10, 15, 20, 25, 50, 100, 250, 500],
    registers: [this.registry],
  });

  /** Called from wherever `EgressError(BLOCKED_ADDRESS)` is caught. Nothing calls it yet. */
  recordEgressBlock(reason: string): void {
    this.egressBlockedTotal.labels(reason).inc();
  }

  /** Called from the tool-call hot path once platform-added time is isolated from provider time. */
  observePlatformLatency(bindingId: string, ms: number): void {
    this.platformAddedLatencyMs.labels(bindingId).observe(ms);
  }

  // ── DB-backed gauges (set by `MetricsCollectorService` on each refresh) ──

  readonly reconciliationDifference = new Gauge({
    name: 'x402_reconciliation_difference',
    help:
      'vault_balance − total_liabilities for the latest reconciliation run, in display units. ' +
      'Page immediately if < 0.',
    labelNames: ['asset'] as const,
    registers: [this.registry],
  });

  readonly reconciliationSeverity = new Gauge({
    name: 'x402_reconciliation_severity',
    help: 'Latest reconciliation run severity: 0=OK, 1=WARN, 2=CRITICAL.',
    labelNames: ['asset'] as const,
    registers: [this.registry],
  });

  readonly reconciliationAgeSeconds = new Gauge({
    name: 'x402_reconciliation_age_seconds',
    help: 'Seconds since the latest reconciliation run for this asset started.',
    labelNames: ['asset'] as const,
    registers: [this.registry],
  });

  readonly falsePositiveRate = new Gauge({
    name: 'x402_verification_false_positive_rate',
    help: 'False positives / resolved slash proposals, trailing 30 days. Warn > 2%, page > 5%.',
    registers: [this.registry],
  });

  readonly disputeOverturnRate = new Gauge({
    name: 'x402_dispute_overturn_rate',
    help: 'Overturned / disputed slash proposals, trailing 30 days. Warn > 20%.',
    registers: [this.registry],
  });

  readonly toolCallSuccessRate = new Gauge({
    name: 'x402_tool_call_success_rate',
    help: 'non-SYSTEM_ERROR / classified PAID calls, trailing 1 hour. Warn < 97%.',
    registers: [this.registry],
  });

  readonly settlementLagP95Seconds = new Gauge({
    name: 'x402_settlement_lag_p95_seconds',
    help: 'p95 verification-record settlement lag, trailing 1 hour. Warn > 60s.',
    registers: [this.registry],
  });

  readonly openHoldOldestAgeSeconds = new Gauge({
    name: 'x402_open_hold_oldest_age_seconds',
    help: 'Age in seconds of the oldest still-OPEN ledger hold. Page > 1h.',
    registers: [this.registry],
  });

  readonly openHoldCount = new Gauge({
    name: 'x402_open_hold_count',
    help: 'Count of ledger_holds rows with status = OPEN.',
    registers: [this.registry],
  });

  readonly failRateByPolicy = new Gauge({
    name: 'x402_verification_fail_rate_by_policy',
    help: 'FAIL verdicts / verdicts, per (policy, policy_version), trailing 1 hour.',
    labelNames: ['policyId', 'policyVersion'] as const,
    registers: [this.registry],
  });

  readonly attestationsSigned = new Gauge({
    name: 'x402_attestations_signed',
    help: 'Verifier signing-journal rows with outcome SIGNED or ATTEMPTED, trailing window.',
    labelNames: ['window'] as const,
    registers: [this.registry],
  });

  readonly slashesExecuted = new Gauge({
    name: 'x402_slashes_executed',
    help: 'slash_proposals rows that reached EXECUTED, trailing window.',
    labelNames: ['window'] as const,
    registers: [this.registry],
  });

  readonly verificationQueueDepth = new Gauge({
    name: 'x402_verification_queue_depth',
    help: 'verification_records rows still in state PENDING.',
    registers: [this.registry],
  });

  readonly verificationQueueP95AgeSeconds = new Gauge({
    name: 'x402_verification_queue_p95_age_seconds',
    help: 'p95 age in seconds of the PENDING verification backlog.',
    registers: [this.registry],
  });

  readonly payoutQueueDepth = new Gauge({
    name: 'x402_payout_queue_depth',
    help: 'provider_payouts rows still PENDING or SUBMITTED (not yet RECORDED).',
    registers: [this.registry],
  });

  readonly intentsPerMinute = new Gauge({
    name: 'x402_intents_per_minute',
    help: 'payment_intents created in the last minute.',
    registers: [this.registry],
  });

  /**
   * `0`/`1`/`2` (OK/WARN/CRITICAL), one series per graded signal — derived
   * from `evaluateGoldenSignal`/`evaluateReserveHealth` in `@shared/alerting`
   * (the tested transcription of the golden-signal thresholds), never from a
   * second copy of the numbers. A signal with no threshold (FAIL rate by policy, attestations signed, slash
   * count, either queue depth) has no series here at all — that omission is
   * deliberate, see `MetricsCollectorService`.
   */
  readonly signalStatus = new Gauge({
    name: 'x402_signal_status',
    help: 'Golden-signal gate status: 0=OK, 1=WARN, 2=CRITICAL.',
    labelNames: ['signal'] as const,
    registers: [this.registry],
  });

  /** Prometheus exposition-format text for `GET /metrics`. */
  async metricsText(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
