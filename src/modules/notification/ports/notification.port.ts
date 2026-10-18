/**
 * How the platform tells a *customer* that something concerns them.
 *
 * ## Why this is not `AlertPort`
 *
 * `AlertPort` was originally expected to have its logging sink replaced by the
 * real notification service. That turned out to be the wrong shape and this port is the correction, so the
 * reasoning is written down here rather than discovered again later.
 *
 * The two have different audiences, and audience is the only thing that matters
 * about a message:
 *
 * | | `AlertPort` | `NotificationPort` |
 * |---|---|---|
 * | Reader | our on-call engineer | the account holder |
 * | Tenant | usually none — reconciler drift belongs to nobody | always exactly one |
 * | Examples | `reserves_breach`, `verifier_signing_rate_elevated` | `balance.low`, `withdrawal.initiated` |
 *
 * Bridging them wholesale would put reconciler drift and verifier-key
 * transitions in a customer's inbox — six of the eight live `AlertPort` call
 * sites carry no `organizationId` at all, and `notifications.organization_id`
 * is `NOT NULL`, so there is not even a tenant to file them under. Where a
 * producer genuinely knows both — the stake monitor does, because
 * `providerId === organizationId` — it emits on **both** ports, and the
 * duplication is the point: the operator and the provider both need to know,
 * and neither is served by the other's copy.
 *
 * ## Implementations must not throw
 *
 * Same rule as `AlertPort`, for the same reason: a notification that fails to
 * send must not take down the thing it was reporting on. A failed `tools/call`
 * that also fails to notify is one problem; a `tools/call` that *succeeds* and
 * then 500s because the mail queue is full is two.
 */

/** Where a notification can be delivered. Mirrors `chk_notification_channels_channel`. */
export enum NotificationChannel {
  /** The dashboard inbox — the `notifications` row itself. Always available. */
  IN_APP = 'IN_APP',
  EMAIL = 'EMAIL',
  PUSH = 'PUSH',
  SLACK = 'SLACK',
  /** The signed HMAC webhook callback. */
  WEBHOOK = 'WEBHOOK',
}

/**
 * Drives placement in the UI, not content.
 *
 * `WARNING`, not `WARN`: `chk_notifications_severity` was written with the
 * long spelling and the column is what a query filters on.
 * `AlertSeverity.WARN` is the short one, so anything speaking both dialects
 * maps explicitly rather than assuming.
 */
export enum NotificationSeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
}

/**
 * How often one event is allowed to reach a human.
 *
 * The aggregation rule is not a setting — it is part of the event
 * definition. At 150M calls/month a per-event stream is a firehose that
 * trains the account holder to ignore us, and `payment_intent.refunded` alone is ~4.5M
 * events/month at a 3% failure rate.
 *
 * Every rule except {@link PER_EVENT} and {@link DIGEST_ONLY} needs the
 * producer to supply a `dedupeKey` naming *what* is being deduplicated — the
 * agent and the band, the credential and the stage, the tool. The catalogue
 * fixes the rule; the producer fixes the grain.
 */
export enum NotificationAggregation {
  /** Every occurrence is delivered. For events that are already rare. */
  PER_EVENT = 'PER_EVENT',
  /** At most one per `dedupeKey`, for as long as the suppression store keeps it. */
  ONCE = 'ONCE',
  /** At most one per `dedupeKey` per UTC day. Covers "once per band per period". */
  ONCE_PER_UTC_DAY = 'ONCE_PER_UTC_DAY',
  /** At most one per `dedupeKey` per UTC month. */
  ONCE_PER_UTC_MONTH = 'ONCE_PER_UTC_MONTH',
  /** One per `dedupeKey`, then silence for the length of an incident. */
  ONCE_PER_INCIDENT = 'ONCE_PER_INCIDENT',
  /** Never delivered on its own. Rolls into the daily digest. */
  DIGEST_ONLY = 'DIGEST_ONLY',
}

/**
 * The whole catalogue, as event names.
 *
 * String values, not numbers, because they are stored in
 * `notifications.event`, filtered on by `GET /notifications?event=`, and shared
 * with the webhook event catalogue. A renumbering would silently reinterpret history.
 *
 * Members with **no producer yet** are marked. They are here rather than
 * omitted because `NotificationCatalogue` is exhaustive over this enum — an
 * event that has to be invented at the call site is an event whose aggregation
 * rule was invented at the call site too.
 */
export enum NotificationEvent {
  // ── Money in and out ────────────────────────────────────────────────────
  BALANCE_LOW = 'balance.low',
  BALANCE_ZERO = 'balance.zero',
  DEPOSIT_CREDITED = 'deposit.credited',
  DEPOSIT_FAILED = 'deposit.failed',
  /** No producer: withdrawals exist, but do not notify yet. */
  WITHDRAWAL_INITIATED = 'withdrawal.initiated',
  /** No producer — see {@link WITHDRAWAL_INITIATED}. */
  WITHDRAWAL_COMPLETED = 'withdrawal.completed',
  /** No producer: there is no withdrawal-destination allowlist yet. */
  WITHDRAWAL_DESTINATION_ADDED = 'withdrawal_destination.added',

  // ── Limits ──────────────────────────────────────────────────────────────
  SPEND_THRESHOLD_CROSSED = 'spend.threshold_crossed',
  VELOCITY_ANOMALY = 'velocity.anomaly',
  AGENT_PAUSED = 'agent.paused',
  /**
   * The same refusal — same agent, tool and code — five times within an hour
   * (design spec §7.10): an agent stuck on a limit or a rule it cannot fix.
   * `McpCallRecorder` is the producer.
   */
  CALL_REFUSED_REPEATEDLY = 'call.refused_repeatedly',

  /**
   * A newer version of a shared toolset an agent of this organization used in
   * the last 30 days (design spec FR-17), with the diff. At most one per
   * toolset per 7 days; `ToolsetNoticesService` is the producer.
   */
  TOOLSET_UPDATE_AVAILABLE = 'toolset.update_available',
  /**
   * A contract major this organization calls through, or serves a binding
   * on, was deprecated: it runs until `sunsetAt` (at least 90 days), then
   * retires (design spec §7.5). Names the replacement.
   * `ContractLifecycleService` is the producer.
   */
  TOOL_VERSION_DEPRECATED = 'tool_version.deprecated',
  /** That major reached its sunset and no longer serves calls. */
  TOOL_VERSION_RETIRED = 'tool_version.retired',

  // ── Credentials and signing ─────────────────────────────────────────────
  SESSION_EXPIRING = 'session.expiring',
  SESSION_EXPIRED = 'session.expired',
  /**
   * An app's OAuth grant was revoked because a rotated refresh token came back
   * after one of its descendants was used: the sign-in was copied (spec
   * §6.3.11). `OAuthTokenService.refresh` is the producer.
   */
  OAUTH_GRANT_STOPPED_REUSE = 'oauth.grant_stopped_reuse',

  // ── Free tier ───────────────────────────────────────────────────────────
  FREE_QUOTA_EXHAUSTED = 'free_quota.exhausted',

  // ── Verification and consequence ────────────────────────────────────────
  /** Never sent individually — `DIGEST_ONLY`. */
  PAYMENT_INTENT_REFUNDED = 'payment_intent.refunded',
  /** No producer: reversal credits exist on chain, not as a notified event. */
  SLASH_COMPENSATION_RECEIVED = 'slash.compensation_received',

  // ── Provider side ───────────────────────────────────────────────────────
  PROVIDER_STAKE_HEADROOM_LOW = 'provider.stake_headroom_low',
  PROVIDER_STAKE_GRACE_OPENED = 'provider.stake_grace_opened',
  PROVIDER_STAKE_GRACE_EXPIRED = 'provider.stake_grace_expired',
  PROVIDER_STAKE_GRACE_CURED = 'provider.stake_grace_cured',
  /** A slash proposal was opened against the provider. */
  PROVIDER_SLASH_PROPOSED = 'provider.slash_proposed',
  /**
   * A window closed `BREACH_PROPOSED` — `SlaWindowService.closeWindow`
   * is the producer.
   */
  PROVIDER_SLA_BREACH_PROPOSED = 'provider.sla_breach_proposed',
  /**
   * Observed rate crosses a configured fraction of the declared one,
   * mid-window.
   * `SlaWindowService.postCall`, via `decideWarning`, is the
   * producer.
   */
  PROVIDER_SLA_WINDOW_WARNING = 'provider.sla_window_warning',
  /**
   * A case was decided — upheld, recalculated or overturned.
   *
   * Not the same event as `PROVIDER_SLASH_PROPOSED`. A provider who was told
   * their capital was at risk is owed the answer, and a decision that only ever
   * appeared inside a dashboard would be indistinguishable, to somebody who
   * stopped checking, from a case nobody ever worked.
   */
  PROVIDER_SLASH_DECIDED = 'provider.slash_decided',
  /** The penalty actually moved on chain. */
  PROVIDER_SLASH_EXECUTED = 'provider.slash_executed',
  /**
   * An executed penalty was reversed and the stake restored.
   *
   * An override the counterparty cannot see is
   * indistinguishable from an error. This is the visible half of the one
   * override that gives money back.
   */
  PROVIDER_SLASH_REVERSED = 'provider.slash_reversed',
  /** No producer: the payout batch is defaulted off. */
  PROVIDER_PAYOUT_SENT = 'provider.payout_sent',

  // ── Buyer call disputes (G3.B1) ─────────────────────────────────────────
  /** A buyer disputed a call this provider served. `CallDisputeService.file`. */
  CALL_DISPUTE_OPENED = 'call_dispute.opened',
  /** The provider replied to the buyer's dispute. Sent to the buyer. */
  CALL_DISPUTE_RESPONDED = 'call_dispute.responded',
  /** An operator upheld or rejected the dispute. Sent to the buyer and the provider. */
  CALL_DISPUTE_DECIDED = 'call_dispute.decided',
  /**
   * The disputed call was refunded before any decision: its provider was
   * blocked and its held payment went back to the buyer. Sent to the buyer.
   * `HeldCollectionService`.
   */
  CALL_DISPUTE_REFUNDED = 'call_dispute.refunded',

  // ── Provider tools (T4) ─────────────────────────────────────────────────
  /**
   * An operator approved a provider tool's review: a first review lists it,
   * a change is published. `ProviderToolReviewService.afterDecision`.
   */
  PROVIDER_TOOL_APPROVED = 'provider_tool.approved',
  /**
   * An operator rejected a review, with a note saying what to fix ("Fix and
   * resubmit", design spec §7.6). An approved version keeps serving.
   */
  PROVIDER_TOOL_REJECTED = 'provider_tool.rejected',
  /** An operator took the tool down: REMOVED from every view, calls refused. `A-25`. */
  PROVIDER_TOOL_TAKEN_DOWN = 'provider_tool.taken_down',
  /**
   * The tool's takedown was rejected, lifted, or lapsed unconfirmed. It serves
   * again unless its handle's takedown still stands.
   */
  PROVIDER_TOOL_TAKEDOWN_LIFTED = 'provider_tool.takedown_lifted',
  /**
   * An operator drafted a standard contract from (or matched it to) one of
   * this provider's tools, and invites the provider to bind to it (§7.5).
   */
  PROVIDER_TOOL_PROMOTION_INVITED = 'provider_tool.promotion_invited',

  // ── Public names (handles) ──────────────────────────────────────────────
  /**
   * An operator took down this organization's public name (`A-17`): every URL
   * under it stops, and its provider tools with it. One notice for the
   * handle, not one per tool.
   */
  HANDLE_TAKEN_DOWN = 'handle.taken_down',
  /** The handle's takedown was rejected, lifted or lapsed: it and its tools serve again. */
  HANDLE_TAKEDOWN_LIFTED = 'handle.takedown_lifted',

  // ── Digest ──────────────────────────────────────────────────────────────
  /** No producer: the daily digest job is not built. */
  DIGEST_DAILY = 'digest.daily',
}

/** What a producer hands the notification service. */
export interface NotificationRequest {
  readonly organizationId: string;
  readonly event: NotificationEvent;
  /**
   * One line, already written for a human. The catalogue supplies severity,
   * channels and aggregation; it does not supply prose, because the numbers in
   * the sentence are the producer's.
   */
  readonly title: string;
  readonly body: string;
  /**
   * Overrides the catalogue's severity for this one occurrence.
   *
   * Exists for `SPEND_THRESHOLD_CROSSED`: one event is split into a
   * `WARNING` at 50/80% and a `CRITICAL` at 100% (the band that has already
   * stopped the agent), and one catalogue row cannot hold two severities. The
   * catalogue's own value is the floor; a producer states this only when it
   * knows something the catalogue could not — never to soften what the
   * catalogue already decided.
   */
  readonly severity?: NotificationSeverity;
  /**
   * What this is *about*, so the UI can deep-link without parsing the body.
   * `payment_intent` / `provider` / `agent` / `binding` / `credential` / …
   */
  readonly subjectType?: string | null;
  readonly subjectId?: string | null;
  /**
   * The event payload, identical to what a webhook consumer would receive.
   * Stored on the row so the in-app view and the webhook cannot disagree about
   * the same event.
   */
  readonly payload?: Readonly<Record<string, unknown>>;
  /**
   * Names what is being deduplicated, for every aggregation rule other than
   * `PER_EVENT` and `DIGEST_ONLY`. Scoped to the organization by the service,
   * so it needs to carry only the grain: `` `${agentId}:daily:80` ``,
   * `` `${credentialId}:T-7` ``, `` `${agentId}:${toolId}` ``.
   *
   * Required in practice for those rules; a missing key degrades to the
   * organization alone, which is almost never the intended grain.
   */
  readonly dedupeKey?: string;
}

/**
 * The sink customer-facing events leave through.
 *
 * One method, and it returns `void` rather than the notification: a producer
 * that can branch on whether its notification was suppressed will eventually
 * branch on it, and suppression is the notification service's business.
 */
export interface NotificationPort {
  notify(request: NotificationRequest): Promise<NotificationOutcome>;
}

/**
 * What `notify` can tell a caller about what just happened.
 *
 * `deliveredNow` is true when at least one channel delivered **synchronously**
 * — in practice `IN_APP`, which `NotificationService` marks `DELIVERED` at
 * insert because the inbox row *is* the delivery and no preference can switch
 * it off. Queued channels are not included: they are still `PENDING` when this
 * returns, and their confirmation arrives later through the deliver processor.
 *
 * It exists because a caller may need to start a clock on delivery, and the
 * only honest moment to start it for the one real channel is here. Callers that
 * do not care ignore the value.
 */
export interface NotificationOutcome {
  readonly deliveredNow: boolean;
}

export const NOTIFICATION_PORT = 'NOTIFICATION_PORT';
