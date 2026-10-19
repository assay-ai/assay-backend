import {
  NotificationAggregation,
  NotificationChannel,
  NotificationEvent,
  NotificationSeverity,
} from '../ports/notification.port';

/**
 * The event catalogue, as code.
 *
 * The table below covers the buyer-side notification events plus the provider
 * events. It is code and not a database table on
 * purpose: *"the aggregation rule is not a setting — it is part of the event
 * definition"*, and the `nonSuppressible` column exists specifically to be
 * un-editable. Every withdrawal event and every consent event is on it, because
 * they are the account-takeover paths — a user who has muted them has muted the
 * only signal that would tell them they are being robbed.
 *
 * `channels` is the **default** fan-out. An organization narrows it through
 * `notification_preferences`, except where `nonSuppressible` refuses.
 *
 * The record is exhaustive over `NotificationEvent` — `Record<NotificationEvent, …>`
 * rather than `Partial<…>` — so adding an event to the enum without deciding
 * its urgency and aggregation is a compile error rather than a silent default.
 */
export interface NotificationDefinition {
  readonly severity: NotificationSeverity;
  readonly channels: readonly NotificationChannel[];
  readonly aggregation: NotificationAggregation;
  /**
   * `true` = no preference row can switch this off. Three classes: every
   * withdrawal event, destination addition, and approval requests.
   */
  readonly nonSuppressible: boolean;
}

const IN_APP_ONLY = [NotificationChannel.IN_APP] as const;
const IN_APP_EMAIL = [NotificationChannel.IN_APP, NotificationChannel.EMAIL] as const;
const IN_APP_EMAIL_PUSH = [
  NotificationChannel.IN_APP,
  NotificationChannel.EMAIL,
  NotificationChannel.PUSH,
] as const;
const EVERYTHING = [
  NotificationChannel.IN_APP,
  NotificationChannel.EMAIL,
  NotificationChannel.PUSH,
  NotificationChannel.SLACK,
] as const;

/**
 * `IN_APP` is on every row that is delivered at all.
 *
 * The original channel lists started at email and push, written before the
 * dashboard inbox existed. The inbox is the screen that answers "what happened
 * while I was away", and an event that reached a phone but left no row behind
 * is invisible to it. Nothing is *only* in-app except the two events whose
 * whole point is that they must not reach a person individually.
 */
export const NOTIFICATION_CATALOGUE: Readonly<Record<NotificationEvent, NotificationDefinition>> =
  Object.freeze({
    // ── Money in and out ──────────────────────────────────────────────────────

    [NotificationEvent.BALANCE_LOW]: {
      severity: NotificationSeverity.WARNING,
      channels: IN_APP_EMAIL_PUSH,
      // "Once per threshold crossing" is an edge, and only the producer can see
      // an edge — it holds the balance before and after. So the rule here is
      // per-event and `LedgerJournalService` is trusted to call only on the
      // crossing. A day-scoped rule would swallow a genuine second crossing after
      // a top-up, which is exactly the one worth hearing about.
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: false,
    },
    [NotificationEvent.BALANCE_ZERO]: {
      severity: NotificationSeverity.CRITICAL,
      channels: IN_APP_EMAIL_PUSH,
      aggregation: NotificationAggregation.ONCE_PER_UTC_DAY,
      nonSuppressible: false,
    },
    [NotificationEvent.DEPOSIT_CREDITED]: {
      severity: NotificationSeverity.INFO,
      channels: IN_APP_EMAIL_PUSH,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: false,
    },
    [NotificationEvent.DEPOSIT_FAILED]: {
      severity: NotificationSeverity.WARNING,
      channels: IN_APP_EMAIL_PUSH,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: false,
    },
    [NotificationEvent.WITHDRAWAL_INITIATED]: {
      severity: NotificationSeverity.CRITICAL,
      channels: IN_APP_EMAIL,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: true,
    },
    [NotificationEvent.WITHDRAWAL_COMPLETED]: {
      severity: NotificationSeverity.WARNING,
      channels: IN_APP_EMAIL,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: true,
    },
    [NotificationEvent.WITHDRAWAL_DESTINATION_ADDED]: {
      severity: NotificationSeverity.CRITICAL,
      channels: IN_APP_EMAIL,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: true,
    },

    // ── Limits ────────────────────────────────────────────────────────────────

    [NotificationEvent.SPEND_THRESHOLD_CROSSED]: {
      // Two urgencies: Medium at 50/80%, High at 100%. One row cannot hold
      // two severities, and the 100% case is the one that has already stopped the
      // agent, so `WARNING` is the floor and the producer raises it — the service
      // takes the severity from the request when the producer states one.
      severity: NotificationSeverity.WARNING,
      channels: IN_APP_EMAIL_PUSH,
      // "Once per band per period": the band and the period both live in the
      // producer's `dedupeKey` (`${agentId}:daily:80`), the day comes from here.
      aggregation: NotificationAggregation.ONCE_PER_UTC_DAY,
      nonSuppressible: false,
    },
    [NotificationEvent.VELOCITY_ANOMALY]: {
      severity: NotificationSeverity.CRITICAL,
      channels: IN_APP_EMAIL_PUSH,
      aggregation: NotificationAggregation.ONCE_PER_INCIDENT,
      nonSuppressible: false,
    },
    [NotificationEvent.CALL_REFUSED_REPEATEDLY]: {
      severity: NotificationSeverity.WARNING,
      channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
      // The producer sees the edge (the fifth refusal in an hour); the day
      // keeps a looping agent from paging its owner every hour.
      aggregation: NotificationAggregation.ONCE_PER_UTC_DAY,
      nonSuppressible: false,
    },
    [NotificationEvent.TOOLSET_UPDATE_AVAILABLE]: {
      severity: NotificationSeverity.INFO,
      channels: IN_APP_EMAIL,
      // The 7-day digest rule is the producer's (`toolset_notice_log`); this
      // keeps one version from ever reaching an organization twice.
      aggregation: NotificationAggregation.ONCE,
      nonSuppressible: false,
    },
    [NotificationEvent.TOOL_VERSION_DEPRECATED]: {
      severity: NotificationSeverity.WARNING,
      channels: IN_APP_EMAIL,
      // One per tool major per organization: the producer's dedupe key.
      aggregation: NotificationAggregation.ONCE,
      nonSuppressible: false,
    },
    [NotificationEvent.TOOL_VERSION_RETIRED]: {
      severity: NotificationSeverity.WARNING,
      channels: IN_APP_EMAIL,
      aggregation: NotificationAggregation.ONCE,
      nonSuppressible: false,
    },
    [NotificationEvent.AGENT_PAUSED]: {
      severity: NotificationSeverity.WARNING,
      channels: EVERYTHING,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: false,
    },

    // ── Credentials and signing ───────────────────────────────────────────────

    [NotificationEvent.SESSION_EXPIRING]: {
      severity: NotificationSeverity.WARNING,
      channels: IN_APP_EMAIL_PUSH,
      // "Exactly twice: T−7d, T−1d." The stage is in the producer's dedupe key,
      // so `ONCE` per key is literally twice per credential.
      aggregation: NotificationAggregation.ONCE,
      nonSuppressible: true,
    },
    [NotificationEvent.SESSION_EXPIRED]: {
      severity: NotificationSeverity.CRITICAL,
      channels: EVERYTHING,
      aggregation: NotificationAggregation.ONCE,
      nonSuppressible: true,
    },

    // ── Free tier ─────────────────────────────────────────────────────────────

    [NotificationEvent.FREE_QUOTA_EXHAUSTED]: {
      severity: NotificationSeverity.INFO,
      channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
      aggregation: NotificationAggregation.ONCE_PER_UTC_DAY,
      nonSuppressible: false,
    },

    // ── Verification and consequence ──────────────────────────────────────────

    [NotificationEvent.PAYMENT_INTENT_REFUNDED]: {
      severity: NotificationSeverity.INFO,
      channels: IN_APP_ONLY,
      // "Nowhere individually." A refund is good news arriving 4.5M times a
      // month; delivered raw it is the firehose that teaches a user to filter us
      // into a folder.
      aggregation: NotificationAggregation.DIGEST_ONLY,
      nonSuppressible: false,
    },
    [NotificationEvent.SLASH_COMPENSATION_RECEIVED]: {
      severity: NotificationSeverity.INFO,
      channels: IN_APP_EMAIL,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: false,
    },

    // ── Provider side ─────────────────────────────────────────────────────────

    [NotificationEvent.PROVIDER_STAKE_HEADROOM_LOW]: {
      severity: NotificationSeverity.WARNING,
      channels: IN_APP_EMAIL,
      // The monitor sweeps every five minutes and the condition persists until
      // the provider tops up — per-event would be 288 identical messages a day,
      // and once a day repeated the same unchanged warning for weeks. Once per
      // incident: the producer's key names the stake and the minimum, so only
      // a change to either is a new incident.
      aggregation: NotificationAggregation.ONCE,
      nonSuppressible: false,
    },
    [NotificationEvent.PROVIDER_STAKE_GRACE_OPENED]: {
      severity: NotificationSeverity.CRITICAL,
      channels: IN_APP_EMAIL_PUSH,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: false,
    },
    [NotificationEvent.PROVIDER_STAKE_GRACE_EXPIRED]: {
      severity: NotificationSeverity.CRITICAL,
      channels: IN_APP_EMAIL_PUSH,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: false,
    },
    [NotificationEvent.PROVIDER_STAKE_GRACE_CURED]: {
      severity: NotificationSeverity.INFO,
      channels: IN_APP_EMAIL,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: false,
    },
    [NotificationEvent.PROVIDER_SLASH_PROPOSED]: {
      severity: NotificationSeverity.CRITICAL,
      channels: EVERYTHING,
      aggregation: NotificationAggregation.PER_EVENT,
      // A proposal to take a provider's capital, with a deadline to object. The
      // same class as a withdrawal: muting it means losing money silently.
      nonSuppressible: true,
    },
    [NotificationEvent.PROVIDER_SLASH_DECIDED]: {
      severity: NotificationSeverity.CRITICAL,
      channels: EVERYTHING,
      aggregation: NotificationAggregation.PER_EVENT,
      // Same class as the proposal it answers. A provider who can mute the
      // proposal but not the verdict, or the other way round, learns half a
      // story; and the half they would miss is the one with the money in it.
      nonSuppressible: true,
    },
    [NotificationEvent.CALL_DISPUTE_OPENED]: {
      severity: NotificationSeverity.WARNING,
      channels: IN_APP_EMAIL,
      aggregation: NotificationAggregation.PER_EVENT,
      // The provider's one chance to reply comes before the decision.
      nonSuppressible: false,
    },
    [NotificationEvent.CALL_DISPUTE_RESPONDED]: {
      severity: NotificationSeverity.INFO,
      channels: IN_APP_ONLY,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: false,
    },
    [NotificationEvent.CALL_DISPUTE_DECIDED]: {
      severity: NotificationSeverity.INFO,
      channels: IN_APP_EMAIL,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: false,
    },
    [NotificationEvent.CALL_DISPUTE_REFUNDED]: {
      severity: NotificationSeverity.INFO,
      channels: IN_APP_EMAIL,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: false,
    },
    [NotificationEvent.PROVIDER_SLASH_EXECUTED]: {
      severity: NotificationSeverity.CRITICAL,
      channels: EVERYTHING,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: true,
    },
    [NotificationEvent.PROVIDER_SLASH_REVERSED]: {
      severity: NotificationSeverity.INFO,
      channels: EVERYTHING,
      aggregation: NotificationAggregation.PER_EVENT,
      // INFO, because it is money coming back, and non-suppressible anyway:
      // an overturn which does not visibly undo the damage
      // is a loss the provider paid for twice. A silenced restoration is
      // exactly that.
      nonSuppressible: true,
    },
    [NotificationEvent.PROVIDER_SLA_BREACH_PROPOSED]: {
      severity: NotificationSeverity.CRITICAL,
      channels: EVERYTHING,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: true,
    },
    [NotificationEvent.PROVIDER_SLA_WINDOW_WARNING]: {
      // Webhook, Slack, inbox — **High**, not Critical. `SlaWindowService`
      // raises the severity to `CRITICAL` per-occurrence for a `CRITICAL`
      // warning level ("slashable, projected breach"), the same override mechanism
      // `SPEND_THRESHOLD_CROSSED` uses for its own two-tier urgency; the
      // catalogue's own value is the floor.
      severity: NotificationSeverity.WARNING,
      channels: [
        NotificationChannel.WEBHOOK,
        NotificationChannel.SLACK,
        NotificationChannel.IN_APP,
      ],
      // The level already lives on `sla_windows.warning_level` and is
      // monotonic — `decideWarning` only ever returns a level strictly higher
      // than the one already stamped, and `stampWarningIfLower`'s conditional
      // `UPDATE` is what makes two concurrent posts notify exactly once. A
      // second suppression layer on top of that would duplicate a guard that
      // already lives on the row, and — unlike Redis suppression, which fails
      // toward *sending* — the row does not, so `PER_EVENT` here is
      // not "unaggregated", it is "aggregated upstream of this service".
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: false,
    },

    // ── Provider tools (T4) ───────────────────────────────────────────────────

    [NotificationEvent.PROVIDER_TOOL_APPROVED]: {
      severity: NotificationSeverity.INFO,
      channels: IN_APP_EMAIL,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: false,
    },
    [NotificationEvent.PROVIDER_TOOL_REJECTED]: {
      // The provider has something to fix before the tool (or its change)
      // reaches the catalogue; nothing already serving stops.
      severity: NotificationSeverity.WARNING,
      channels: IN_APP_EMAIL,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: false,
    },
    [NotificationEvent.PROVIDER_TOOL_TAKEN_DOWN]: {
      severity: NotificationSeverity.CRITICAL,
      channels: IN_APP_EMAIL_PUSH,
      aggregation: NotificationAggregation.PER_EVENT,
      // The tool stopped serving everywhere at once. A provider who muted
      // this would learn it from their traffic graph, days later.
      nonSuppressible: true,
    },
    [NotificationEvent.PROVIDER_TOOL_TAKEDOWN_LIFTED]: {
      severity: NotificationSeverity.INFO,
      channels: IN_APP_EMAIL,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: false,
    },
    [NotificationEvent.PROVIDER_TOOL_PROMOTION_INVITED]: {
      severity: NotificationSeverity.INFO,
      channels: IN_APP_EMAIL,
      // One per (standard tool, provider tool): the producer's dedupe key. An
      // invite re-sent for the same pair is the same invitation.
      aggregation: NotificationAggregation.ONCE,
      nonSuppressible: false,
    },

    // ── Public names (handles) ────────────────────────────────────────────────

    [NotificationEvent.HANDLE_TAKEN_DOWN]: {
      severity: NotificationSeverity.CRITICAL,
      channels: IN_APP_EMAIL_PUSH,
      aggregation: NotificationAggregation.PER_EVENT,
      // Every URL and provider tool under the name stopped at once: the same
      // class as a tool's own takedown.
      nonSuppressible: true,
    },
    [NotificationEvent.HANDLE_TAKEDOWN_LIFTED]: {
      severity: NotificationSeverity.INFO,
      channels: IN_APP_EMAIL,
      aggregation: NotificationAggregation.PER_EVENT,
      nonSuppressible: false,
    },

    // ── Digest ────────────────────────────────────────────────────────────────

    [NotificationEvent.DIGEST_DAILY]: {
      severity: NotificationSeverity.INFO,
      channels: IN_APP_EMAIL,
      aggregation: NotificationAggregation.ONCE_PER_UTC_DAY,
      nonSuppressible: false,
    },
  });

/**
 * How long `ONCE_PER_INCIDENT` stays quiet.
 *
 * An hour, because that is roughly how long it takes a human to notice a
 * runaway agent, pause it and confirm it stopped. Shorter and the second alert
 * arrives while they are still reading the first; much longer and a genuinely
 * new incident is swallowed by the old one's silence.
 */
export const NOTIFICATION_INCIDENT_WINDOW_SECONDS = 60 * 60;

/**
 * How long an `ONCE` suppression key survives.
 *
 * "Forever" is not available in a Redis suppression cache and pretending
 * otherwise would be the lie this constant exists to avoid. 90 days covers the
 * two `ONCE` users — a credential's T−7d/T−1d warnings and the expiry that
 * follows — with room to spare, because the credential itself is gone before
 * the key is.
 */
export const NOTIFICATION_ONCE_TTL_SECONDS = 90 * 24 * 60 * 60;
