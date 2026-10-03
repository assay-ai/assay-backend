/**
 * How the platform says something is wrong to a human.
 *
 * The golden signals distinguish *warn* from *page*, and the distinction is the
 * whole point of this port: a reserve breach must reach an on-call phone, while
 * a low gas runway must not. A service that decides "this is serious" and then
 * writes `logger.error` has made half the decision and thrown the other half
 * away — nothing downstream can tell that line apart from any other error line,
 * so nothing routes it.
 *
 * So severity is a required field of the alert, not a choice of log method,
 * and `details` is a map of numbers rather than a pre-formatted sentence. An
 * alert that says "reserves breached" without saying by how much sends someone
 * to a dashboard at 3am to find out.
 */
export enum AlertSeverity {
  /** Worth recording; nobody is woken. */
  INFO = 'INFO',
  /** A human should look during working hours. */
  WARN = 'WARN',
  /** Page on-call now. Money is wrong, or may be. */
  CRITICAL = 'CRITICAL',
}

/**
 * How often one `name`+`dedupeKey` pair is allowed to reach the paging sinks
 * (Telegram, webhook) while its underlying condition keeps being true.
 *
 * Mirrors `NotificationAggregation` (`notification.port.ts`) one rule deep:
 * every `AlertPort` call site is a "this is still true" loop — a cron pass, a
 * signing request — never a one-off event, so there is no calendar-scoped
 * grain here, only "keep paging" and "page once, then hold for the incident
 * window". `LoggingAlertSink` ignores this field entirely and always records
 * every call — see `SuppressingAlertSink`'s class comment for why.
 */
export enum AlertAggregation {
  /** Every call reaches every sink. The default when omitted — existing behaviour. */
  PER_EVENT = 'PER_EVENT',
  /** At most one per `name`+`dedupeKey` per incident window. */
  ONCE_PER_INCIDENT = 'ONCE_PER_INCIDENT',
}

export interface Alert {
  readonly severity: AlertSeverity;
  /**
   * Stable, greppable identifier for *this kind* of alert —
   * `reserves_breach`, `gas_runway_critical`. Routing keys off this, so it
   * must not carry per-occurrence values; those go in `details`.
   */
  readonly name: string;
  /** One line a human reads first. */
  readonly summary: string;
  /**
   * The numbers. Every figure that went into the decision belongs here, so the
   * alert is actionable without opening anything else.
   */
  readonly details: Readonly<Record<string, string | number>>;
  /** Defaults to `PER_EVENT` when omitted. */
  readonly aggregation?: AlertAggregation;
  /**
   * Names what is being deduplicated within `name` — a binding id, a key id,
   * a `code:asset` pair. Required in practice for `ONCE_PER_INCIDENT`; a
   * missing key degrades to `name` alone, which is almost never the intended
   * grain when several instances of the same condition can be open at once.
   */
  readonly dedupeKey?: string;
  /**
   * How long this alert holds its `ONCE_PER_INCIDENT` silence, in seconds.
   * Omitted means `ALERT_INCIDENT_WINDOW_SECONDS` (one hour), which is the
   * right grain for a condition someone is expected to act on while paged.
   *
   * It is not the right grain for every standing condition. A reconciliation
   * surplus is money nobody can spend until a human backfills a journal entry
   * — a day, sometimes longer — and paging hourly about it neither speeds that
   * up nor tells anyone something they did not already know; it only teaches
   * the channel to be ignored, which then costs a `CRITICAL` its audience. So
   * the window is a property of the alert rather than of the sink.
   *
   * Ignored (falls back to the default) unless it is a positive whole number:
   * Redis refuses `EX 0`, and a bad config value must not turn every alert
   * into a throw inside the thing that was reporting a problem.
   */
  readonly suppressionWindowSeconds?: number;
}

/**
 * The sink alerts leave through.
 *
 * One method rather than `page()` / `warn()` / `info()` so a caller cannot
 * raise an alert without stating a severity, and so adding a level is a
 * change to the enum rather than to every implementation.
 *
 * Implementations must not throw: an alert that fails to send must not take
 * down the thing that was trying to report a problem. This port is **not**
 * replaced by `NotificationPort` (`src/modules/notification/ports/notification.port.ts`)
 * — the two stayed separate because they have different
 * readers (on-call engineer vs. account holder) and most `AlertPort` call
 * sites carry no `organizationId` to file a customer notification under; see
 * that port's own class comment for the full reasoning.
 */
export interface AlertPort {
  emit(alert: Alert): Promise<void>;
}

export const ALERT_PORT = 'ALERT_PORT';
