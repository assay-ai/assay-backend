/**
 * The union of the seven named observability signals and the ten golden-signal
 * rows — fifteen distinct signals once the two lists' overlaps are folded together
 * (reconciler drift *is* reserve health; "p95 latency by binding" *is*
 * platform latency, labelled).
 *
 * This file is the single place that says, for each one, whether this
 * codebase currently has a data source for it. `MetricsCollectorService`
 * reads {@link SIGNAL_SOURCE} before computing a gauge; a `NONE` entry means
 * the collector must not register or set that series at all — Prometheus's
 * own `absent()` then reports it accurately as missing, rather than the
 * collector fabricating a `0` that reads as "healthy: nothing found."
 *
 * The golden-signal thresholds gate the number, not the metric — see
 * `SIGNAL_GATE`. Everything with a `GoldenSignal` entry is graded through
 * `evaluateGoldenSignal`/`evaluateReserveHealth` in `@shared/alerting`, the
 * one already-tested transcription of those thresholds; nothing here
 * re-derives a number that lives there.
 */
export enum ObservabilitySignal {
  RESERVE_HEALTH = 'RESERVE_HEALTH',
  FALSE_POSITIVE_RATE = 'FALSE_POSITIVE_RATE',
  FALSE_NEGATIVE_RATE = 'FALSE_NEGATIVE_RATE',
  DISPUTE_OVERTURN_RATE = 'DISPUTE_OVERTURN_RATE',
  GAS_RUNWAY_DAYS = 'GAS_RUNWAY_DAYS',
  TOOL_CALL_SUCCESS_RATE = 'TOOL_CALL_SUCCESS_RATE',
  PLATFORM_LATENCY_P95_BY_BINDING = 'PLATFORM_LATENCY_P95_BY_BINDING',
  SETTLEMENT_LAG_P95 = 'SETTLEMENT_LAG_P95',
  PAYOUT_LAG_P95 = 'PAYOUT_LAG_P95',
  OPEN_HOLD_AGE = 'OPEN_HOLD_AGE',
  FAIL_RATE_BY_POLICY = 'FAIL_RATE_BY_POLICY',
  ATTESTATIONS_SIGNED = 'ATTESTATIONS_SIGNED',
  SLASH_COUNT = 'SLASH_COUNT',
  VERIFICATION_QUEUE_DEPTH = 'VERIFICATION_QUEUE_DEPTH',
  EGRESS_BLOCKS = 'EGRESS_BLOCKS',
}

export enum SignalAvailability {
  /** Backed by a real query against a table already written elsewhere. */
  SOURCED = 'SOURCED',
  /**
   * Backed by an in-process instrument (a prom-client `Counter`/`Histogram`)
   * that this change registers, but that nothing in the codebase calls yet —
   * see `MetricsRegistryService`'s recording methods. Distinct from `NONE`: the seam exists and is
   * named; it is one call-site addition away from reporting real numbers,
   * not a redesign away.
   */
  AWAITING_INSTRUMENTATION = 'AWAITING_INSTRUMENTATION',
  /** No table, column or in-process counter anywhere in this codebase computes this today. */
  NONE = 'NONE',
}

export interface SignalDescriptor {
  readonly signal: ObservabilitySignal;
  readonly label: string;
  readonly availability: SignalAvailability;
  /** Why, when {@link availability} is not `SOURCED` — read by the dashboard's "absent" note. */
  readonly reason?: string;
}

/**
 * One row per {@link ObservabilitySignal}. `MetricsCollectorService` and the
 * dashboard controller both read this rather than each hard-coding their own
 * copy of which signals are real — see the class doc for why a `NONE` row
 * must never be defaulted to zero.
 */
export const SIGNAL_CATALOG: Readonly<Record<ObservabilitySignal, SignalDescriptor>> = {
  [ObservabilitySignal.RESERVE_HEALTH]: {
    signal: ObservabilitySignal.RESERVE_HEALTH,
    label: 'Reserve health (vault − liabilities)',
    availability: SignalAvailability.SOURCED,
  },
  [ObservabilitySignal.FALSE_POSITIVE_RATE]: {
    signal: ObservabilitySignal.FALSE_POSITIVE_RATE,
    label: 'Verification false-positive rate (proxy)',
    availability: SignalAvailability.SOURCED,
    reason:
      'This is SlashProposalRepository.falsePositiveCounts — the same resolved-slash-dispute proxy ' +
      "PlatformHealthService already shows on GET /operator/health, NOT the doc's labelled-sample " +
      "rate. golden-signals.ts's own docstring on GoldenSignal.FALSE_POSITIVE_RATE forbids feeding a " +
      'dispute-derived number into that evaluator ("never wire a dispute-overturn number into this ' +
      'signal"), so this reading is shown with no gate rather than misapplying the 2%/5% threshold.',
  },
  [ObservabilitySignal.FALSE_NEGATIVE_RATE]: {
    signal: ObservabilitySignal.FALSE_NEGATIVE_RATE,
    label: 'Verification false-negative rate',
    availability: SignalAvailability.NONE,
    reason:
      'Measured against a manually labelled sample of PASS verdicts, drawn daily — the doc is ' +
      'explicit that this must never be derived from disputes. No labelling pipeline exists in ' +
      'this codebase (the false-positive rate at least has SlashProposalRepository.falsePositiveCounts ' +
      'as a proxy against overturned slashes; the false-negative side has no equivalent producer at all).',
  },
  [ObservabilitySignal.DISPUTE_OVERTURN_RATE]: {
    signal: ObservabilitySignal.DISPUTE_OVERTURN_RATE,
    label: 'Dispute overturn rate',
    availability: SignalAvailability.SOURCED,
  },
  [ObservabilitySignal.GAS_RUNWAY_DAYS]: {
    signal: ObservabilitySignal.GAS_RUNWAY_DAYS,
    label: 'Gas runway (days)',
    availability: SignalAvailability.NONE,
    reason:
      'No FacilitatorPort method reads ' +
      'a fee-payer balance or a daily gas burn anywhere in this codebase today.',
  },
  [ObservabilitySignal.TOOL_CALL_SUCCESS_RATE]: {
    signal: ObservabilitySignal.TOOL_CALL_SUCCESS_RATE,
    label: 'Tool-call success rate',
    availability: SignalAvailability.SOURCED,
    reason:
      'Computed over payment_intents.classification (the PAID path) only. Free/freemium calls ' +
      'land in tool_call_records instead and are not folded in.',
  },
  [ObservabilitySignal.PLATFORM_LATENCY_P95_BY_BINDING]: {
    signal: ObservabilitySignal.PLATFORM_LATENCY_P95_BY_BINDING,
    label: 'Platform-added latency p95, by binding',
    availability: SignalAvailability.AWAITING_INSTRUMENTATION,
    reason:
      'No column or span anywhere separates platform-added time from provider time. A Histogram ' +
      'is registered and MetricsRegistryService.observePlatformLatency(bindingId, ms) is ready to ' +
      'receive it; nothing calls it yet.',
  },
  [ObservabilitySignal.SETTLEMENT_LAG_P95]: {
    signal: ObservabilitySignal.SETTLEMENT_LAG_P95,
    label: 'Settlement lag p95',
    availability: SignalAvailability.SOURCED,
    reason:
      "Approximated as verification_records.settled_at − created_at, not payment_intents' own " +
      'VERIFYING → terminal transition (that transition carries no timestamp pair of its own).',
  },
  [ObservabilitySignal.PAYOUT_LAG_P95]: {
    signal: ObservabilitySignal.PAYOUT_LAG_P95,
    label: 'Payout lag p95 (credit → on-chain confirmation)',
    availability: SignalAvailability.NONE,
    reason:
      'provider_payouts has no confirmed-on-chain timestamp — "SUBMITTED" means a Squads ' +
      'instruction was built, not confirmed. The batch is also OFF by ' +
      'default (PROVIDER_PAYOUT_EXECUTION_ENABLED), so there would be little real data regardless.',
  },
  [ObservabilitySignal.OPEN_HOLD_AGE]: {
    signal: ObservabilitySignal.OPEN_HOLD_AGE,
    label: 'Oldest open hold, age',
    availability: SignalAvailability.SOURCED,
  },
  [ObservabilitySignal.FAIL_RATE_BY_POLICY]: {
    signal: ObservabilitySignal.FAIL_RATE_BY_POLICY,
    label: 'FAIL verdict rate, by policy',
    availability: SignalAvailability.SOURCED,
  },
  [ObservabilitySignal.ATTESTATIONS_SIGNED]: {
    signal: ObservabilitySignal.ATTESTATIONS_SIGNED,
    label: 'Attestations signed',
    availability: SignalAvailability.SOURCED,
  },
  [ObservabilitySignal.SLASH_COUNT]: {
    signal: ObservabilitySignal.SLASH_COUNT,
    label: 'Slashes executed',
    availability: SignalAvailability.SOURCED,
    reason:
      'slash_proposals has no dedicated executed_at column — windowed on updated_at, which is a ' +
      'proxy (last write to the row, expected to be the EXECUTED transition for a row in that state).',
  },
  [ObservabilitySignal.VERIFICATION_QUEUE_DEPTH]: {
    signal: ObservabilitySignal.VERIFICATION_QUEUE_DEPTH,
    label: 'Verification queue depth',
    availability: SignalAvailability.SOURCED,
  },
  [ObservabilitySignal.EGRESS_BLOCKS]: {
    signal: ObservabilitySignal.EGRESS_BLOCKS,
    label: 'Egress calls blocked',
    availability: SignalAvailability.AWAITING_INSTRUMENTATION,
    reason:
      'EgressError(BLOCKED_ADDRESS) is thrown and returned to the caller; nothing persists it. ' +
      'A Counter is registered and MetricsRegistryService.recordEgressBlock(reason) is ready to ' +
      'receive it; nothing calls it yet.',
  },
};
