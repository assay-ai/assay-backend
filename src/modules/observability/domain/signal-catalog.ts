/**
 * The union of the seven named observability signals and the ten golden-signal
 * rows — fifteen distinct signals once the two lists' overlaps are folded together
 * (reconciler drift *is* reserve health; "p95 latency by binding" *is*
 * platform latency, labelled).
 *
 * This file is the single place that says, for each one, whether this
 * codebase currently has a data source for it. `MetricsCollectorService`
 * reads {@link SIGNAL_SOURCE} before computing a reading; a `NONE` entry means
 * the reading is reported as absent, rather than the collector fabricating a
 * `0` that reads as "healthy: nothing found."
 *
 * The `OAUTH_*` and `MCP_UNAUTHORIZED` rows are the OAuth signals of the
 * buyer MCP onboarding spec (§6.7): read from the OAuth tables where the fact
 * is stored, and from the Redis hourly counters `OAuthMetrics` writes where it
 * exists only on the request path (`OAuthSignalsReader`). Their §6.7 alerts
 * are graded in `oauth-signal-gates.ts`.
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
  // The OAuth signals of the buyer MCP onboarding spec, §6.7 (section `oauth`).
  OAUTH_LIVE_GRANTS = 'OAUTH_LIVE_GRANTS',
  OAUTH_LIVE_GRANTS_PER_AGENT_MAX = 'OAUTH_LIVE_GRANTS_PER_AGENT_MAX',
  OAUTH_GRANTS_STOPPED_FOR_REUSE = 'OAUTH_GRANTS_STOPPED_FOR_REUSE',
  OAUTH_REFRESH_STALE_REUSE = 'OAUTH_REFRESH_STALE_REUSE',
  OAUTH_REFRESH_GRACE_USES = 'OAUTH_REFRESH_GRACE_USES',
  OAUTH_DCR_REGISTRATIONS = 'OAUTH_DCR_REGISTRATIONS',
  OAUTH_CIMD_CLIENTS = 'OAUTH_CIMD_CLIENTS',
  OAUTH_TOKEN_RESULTS = 'OAUTH_TOKEN_RESULTS',
  OAUTH_CONSENT_STEPS = 'OAUTH_CONSENT_STEPS',
  OAUTH_CONTINUE_COOKIE_MISSING = 'OAUTH_CONTINUE_COOKIE_MISSING',
  OAUTH_AUTHORIZE_OUTCOMES = 'OAUTH_AUTHORIZE_OUTCOMES',
  OAUTH_CIMD_FETCHES = 'OAUTH_CIMD_FETCHES',
  MCP_UNAUTHORIZED = 'MCP_UNAUTHORIZED',
}

export enum SignalAvailability {
  /** Backed by a real query against a table already written elsewhere. */
  SOURCED = 'SOURCED',
  /** No table, column or counter anywhere in this codebase computes this today. */
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
    availability: SignalAvailability.NONE,
    reason: 'No column or span anywhere separates platform-added time from provider time.',
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
      'Providers are paid in the same transaction that redeems a voucher, so there is no ' +
      'separate payout to time.',
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
    availability: SignalAvailability.NONE,
    reason:
      'EgressError(BLOCKED_ADDRESS) is thrown and returned to the caller; nothing persists or ' +
      'counts it.',
  },
  [ObservabilitySignal.OAUTH_LIVE_GRANTS]: {
    signal: ObservabilitySignal.OAUTH_LIVE_GRANTS,
    label: 'OAuth live grants',
    availability: SignalAvailability.SOURCED,
    reason:
      'Live OAuth credentials (agent_credentials, issued_via OAUTH, not revoked, deleted or expired), all agents.',
  },
  [ObservabilitySignal.OAUTH_LIVE_GRANTS_PER_AGENT_MAX]: {
    signal: ObservabilitySignal.OAUTH_LIVE_GRANTS_PER_AGENT_MAX,
    label: 'OAuth live grants, most held by one agent',
    availability: SignalAvailability.SOURCED,
    reason:
      'The largest per-agent count of live OAuth credentials, against the cap of 50. Warn at 45.',
  },
  [ObservabilitySignal.OAUTH_GRANTS_STOPPED_FOR_REUSE]: {
    signal: ObservabilitySignal.OAUTH_GRANTS_STOPPED_FOR_REUSE,
    label: 'OAuth grants stopped for reuse',
    availability: SignalAvailability.SOURCED,
    reason:
      'agent_credentials revoked in the last 24h with revoked_by system:oauth-refresh-reuse or system:oauth-code-reused. Any is critical.',
  },
  [ObservabilitySignal.OAUTH_REFRESH_STALE_REUSE]: {
    signal: ObservabilitySignal.OAUTH_REFRESH_STALE_REUSE,
    label: 'OAuth stale refresh-token reuse',
    availability: SignalAvailability.SOURCED,
    reason:
      'Audit oauth.refresh_stale_reuse in the last 24h: a rotated refresh token came back after the grace, and nothing had used its descendants, so nothing was stopped.',
  },
  [ObservabilitySignal.OAUTH_REFRESH_GRACE_USES]: {
    signal: ObservabilitySignal.OAUTH_REFRESH_GRACE_USES,
    label: 'OAuth refresh grace uses',
    availability: SignalAvailability.SOURCED,
    reason: 'Audit oauth.refresh_grace_used in the last 24h.',
  },
  [ObservabilitySignal.OAUTH_DCR_REGISTRATIONS]: {
    signal: ObservabilitySignal.OAUTH_DCR_REGISTRATIONS,
    label: 'OAuth DCR registrations',
    availability: SignalAvailability.SOURCED,
    reason:
      'oauth_clients rows of kind DCR created in the last 24h; extra.maxPerClientName is the most under one client_name. Warn at 1000 in total or above 100 for one name.',
  },
  [ObservabilitySignal.OAUTH_CIMD_CLIENTS]: {
    signal: ObservabilitySignal.OAUTH_CIMD_CLIENTS,
    label: 'OAuth CIMD clients',
    availability: SignalAvailability.SOURCED,
    reason: 'oauth_clients rows of kind CIMD.',
  },
  [ObservabilitySignal.OAUTH_TOKEN_RESULTS]: {
    signal: ObservabilitySignal.OAUTH_TOKEN_RESULTS,
    label: 'OAuth token requests',
    availability: SignalAvailability.SOURCED,
    reason:
      'POST /oauth/token results; extra is keyed {grant_type}.{result}. Redis hourly counters (`oauth:m:*`, written by `OAuthMetrics`), summed over the last 24 hourly buckets.',
  },
  [ObservabilitySignal.OAUTH_CONSENT_STEPS]: {
    signal: ObservabilitySignal.OAUTH_CONSENT_STEPS,
    label: 'OAuth consents approved',
    availability: SignalAvailability.SOURCED,
    reason:
      'Consent steps; value is approved, extra has every step. Redis hourly counters (`oauth:m:*`, written by `OAuthMetrics`), summed over the last 24 hourly buckets.',
  },
  [ObservabilitySignal.OAUTH_CONTINUE_COOKIE_MISSING]: {
    signal: ObservabilitySignal.OAUTH_CONTINUE_COOKIE_MISSING,
    label: 'OAuth continue without the request cookie',
    availability: SignalAvailability.SOURCED,
    reason:
      'Value is the trailing-hour estimate (the current hourly bucket plus the elapsed share of the previous one). Warn above 5% of approved over the same hour.',
  },
  [ObservabilitySignal.OAUTH_AUTHORIZE_OUTCOMES]: {
    signal: ObservabilitySignal.OAUTH_AUTHORIZE_OUTCOMES,
    label: 'OAuth authorize requests stored',
    availability: SignalAvailability.SOURCED,
    reason:
      'GET /oauth/authorize outcomes; value is stored, extra has every outcome. Redis hourly counters (`oauth:m:*`, written by `OAuthMetrics`), summed over the last 24 hourly buckets.',
  },
  [ObservabilitySignal.OAUTH_CIMD_FETCHES]: {
    signal: ObservabilitySignal.OAUTH_CIMD_FETCHES,
    label: 'OAuth CIMD fetches',
    availability: SignalAvailability.SOURCED,
    reason:
      'Client ID metadata document fetches by result. Warn on any blocked_address. Redis hourly counters (`oauth:m:*`, written by `OAuthMetrics`), summed over the last 24 hourly buckets.',
  },
  [ObservabilitySignal.MCP_UNAUTHORIZED]: {
    signal: ObservabilitySignal.MCP_UNAUTHORIZED,
    label: 'MCP 401s',
    availability: SignalAvailability.SOURCED,
    reason:
      '401s from the MCP catch-all, by reason. Redis hourly counters (`oauth:m:*`, written by `OAuthMetrics`), summed over the last 24 hourly buckets.',
  },
};
