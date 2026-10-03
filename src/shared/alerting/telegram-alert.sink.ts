import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  EgressHttpClient,
  UNTRUSTED_EGRESS_POLICY,
  isEgressError,
  withLimits,
} from '@shared/network/egress';

import { Alert, AlertPort, AlertSeverity } from './alert.port';

const SEVERITY_ORDER: Readonly<Record<AlertSeverity, number>> = {
  [AlertSeverity.INFO]: 0,
  [AlertSeverity.WARN]: 1,
  [AlertSeverity.CRITICAL]: 2,
};

const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** Telegram rejects anything over 4096 UTF-16 code units for `sendMessage`. */
const MAX_TEXT_LENGTH = 4000;

/**
 * Quiet hours never apply to the Critical class, and Critical must still make noise. INFO/WARN
 * are silenced client-side (no push/sound) rather than routed away — they
 * still land in the chat for the morning read.
 */
const QUIET_SEVERITIES: ReadonlySet<AlertSeverity> = new Set([
  AlertSeverity.INFO,
  AlertSeverity.WARN,
]);

/**
 * Sliding window: Telegram's Bot API documents roughly 30 messages/second
 * globally and roughly 20/minute to any one chat/group before it starts
 * throttling the bot. We only ever address one chat from this process, so
 * the per-minute figure is the binding constraint — bounding to 20 sends per
 * rolling 60s keeps every burst under the per-second ceiling too (20 messages
 * inside even a single second is still under 30/s).
 *
 * A storm of alerts beyond that is *dropped*, not queued and not retried:
 * queuing would turn an incident into a backlog of stale pages arriving
 * minutes late, and retrying risks tipping the bot into a longer throttle.
 * `LoggingAlertSink` — run by the same `FanOutAlertSink` — has already
 * written every one of these alerts to the log before this sink ever sees
 * them, so a dropped Telegram message is not a lost alert.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_WINDOW = 20;

export interface TelegramAlertSinkConfig {
  readonly enabled: boolean;
  readonly botToken?: string;
  /**
   * Empty until a human messages the bot first (Telegram bots cannot open a
   * conversation). Absence is a normal, permanent-until-configured state —
   * never a failure.
   */
  readonly chatId?: string;
  /**
   * A forum topic inside `chatId`, when the target group has topics enabled.
   *
   * Optional and independent of `chatId`: a plain chat has no topics, and a
   * forum group with this unset delivers to "General" — which is where an
   * on-call message is least likely to be read, so it is worth setting.
   * Telegram rejects `message_thread_id` on a non-forum chat, so it is omitted
   * entirely rather than sent as null.
   */
  readonly messageThreadId?: number;
  /** Alerts below this severity never reach Telegram, only the log. */
  readonly minSeverity: AlertSeverity;
  /** Per-call ceiling. Bounds how long `emit` can block the caller. */
  readonly timeoutMs: number;
}

export const TELEGRAM_ALERT_SINK_CONFIG = 'TELEGRAM_ALERT_SINK_CONFIG';

/**
 * The paging sink: one Telegram Bot API `sendMessage` call per alert.
 *
 * ## Why `UNTRUSTED_EGRESS_POLICY` / `PUBLIC_ONLY`
 *
 * Same reasoning as `WebhookAlertSink` (read that docstring first): the bot
 * token is read from `process.env` at boot, which makes `INTERNAL_ALLOWED`
 * look tempting, but `api.telegram.org` is a third-party public endpoint —
 * `PUBLIC_ONLY` never gets in the way of the legitimate call, and it keeps a
 * misconfigured/compromised env value from being handed a pass into a
 * private address. Still routed through `EgressHttpClient` only.
 *
 * ## The bot token must never reach a log line
 *
 * The token is part of the request *path* —
 * `https://api.telegram.org/bot<TOKEN>/sendMessage` — not a header, so it
 * cannot be kept out of a URL by omission the way a bearer token can. It also
 * cannot be caught by `src/shared/observability/redact.ts`, which redacts by
 * *key name* on structured objects; a URL embedded inside a free-text log
 * message is invisible to it. So this class never logs `error.message`,
 * `error.url`, or the response's `url` from `EgressHttpClient` — none of
 * those are trusted not to carry the token — and every string this class
 * does log is passed through {@link redactBotToken} as a second, independent
 * guard against the token leaking through some future edit.
 *
 * ## Missing chat id is "not configured", not a failure
 *
 * `ALERT_TELEGRAM_CHAT_ID` starts empty on purpose — a Telegram bot cannot
 * start a conversation, so a human has to message it first. This class does
 * **not** call `getUpdates` to discover a chat id itself: that would race
 * any other consumer of the same bot and could silently change who gets
 * paged. It logs the gap once (not once per alert — a chat id that is still
 * empty next Tuesday should not still be filling the log) and degrades,
 * exactly like `WebhookAlertSink` degrades when a severity has no URL.
 *
 * ## Must not throw, must not block indefinitely
 *
 * Both from `AlertPort`'s contract, same as `WebhookAlertSink`: every
 * failure is caught and logged, never re-thrown, and the call runs under a
 * tightened `totalTimeoutMs` rather than the 30s default.
 *
 * ## Message formatting
 *
 * Sent as **plain text** — `parse_mode` is deliberately omitted. Telegram's
 * `MarkdownV2` requires escaping a long, easy-to-miss list of characters
 * (`. - ! ( ) [ ] { }` and more); an unescaped one makes the whole
 * `sendMessage` call fail with `400 Bad Request`, which would silently drop
 * the page over a formatting bug. Alert summaries and detail keys are
 * operator/system-generated free text (amounts, ids, error strings) that
 * cannot be guaranteed Markdown-safe, so plain text — ugly but never
 * rejected — is the one that cannot lose an alert to an escaping mistake.
 *
 * ## Compose, don't replace
 *
 * Same as `WebhookAlertSink`: this does not write to the process logger on
 * success. `FanOutAlertSink` runs this beside `LoggingAlertSink`, so the log
 * line stands regardless of what Telegram does.
 */
@Injectable()
export class TelegramAlertSink implements AlertPort {
  private readonly logger = new Logger(TelegramAlertSink.name);
  private hasWarnedMissingChatId = false;
  private sendTimestamps: number[] = [];

  constructor(
    private readonly egress: EgressHttpClient,
    @Inject(TELEGRAM_ALERT_SINK_CONFIG) private readonly config: TelegramAlertSinkConfig,
  ) {}

  async emit(alert: Alert): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    if (SEVERITY_ORDER[alert.severity] < SEVERITY_ORDER[this.config.minSeverity]) {
      return;
    }

    if (!this.config.botToken) {
      // Config validation requires the token whenever ALERT_TELEGRAM_ENABLED
      // is true (see `observability.config.ts`), so reaching this means the
      // config was built by hand (e.g. a test) rather than a real gap — but
      // the same "never throw" contract applies either way.
      this.logger.warn('No Telegram bot token configured; alert did not reach Telegram');
      return;
    }

    if (!this.config.chatId) {
      if (!this.hasWarnedMissingChatId) {
        this.hasWarnedMissingChatId = true;
        this.logger.warn(
          'ALERT_TELEGRAM_CHAT_ID is not set — Telegram alerting is enabled but has nowhere ' +
            'to send to. A human must message the bot first (bots cannot start a conversation); ' +
            'this warning will not repeat. The log line for each alert still stands.',
        );
      }
      return;
    }

    if (!this.tryReserveRateLimitSlot()) {
      this.logger.warn(
        `Telegram send rate limit reached (${RATE_LIMIT_MAX_PER_WINDOW}/${RATE_LIMIT_WINDOW_MS}ms); ` +
          `dropping ${alert.name} on this sink — the log line still stands`,
      );
      return;
    }

    const url = `${TELEGRAM_API_BASE}/bot${this.config.botToken}/sendMessage`;

    try {
      const response = await this.egress.request({
        url,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          ...(this.config.messageThreadId === undefined
            ? {}
            : { message_thread_id: this.config.messageThreadId }),
          text: toMessageText(alert),
          disable_notification: QUIET_SEVERITIES.has(alert.severity),
        }),
        policy: withLimits(UNTRUSTED_EGRESS_POLICY, { totalTimeoutMs: this.config.timeoutMs }),
      });

      if (response.status >= 300) {
        this.logger.warn(
          this.redactToken(
            `Telegram refused ${alert.name}: HTTP ${response.status} ${response.body.slice(0, 200)}`,
          ),
        );
      }
    } catch (error) {
      this.logger.warn(
        this.redactToken(
          `Telegram delivery failed for ${alert.name} (${this.describeSendFailure(error)}); ` +
            'relying on the log line',
        ),
      );
    }
  }

  /** `true` if a slot was reserved (caller should send); `false` if over the window's cap. */
  private tryReserveRateLimitSlot(now: number = Date.now()): boolean {
    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    this.sendTimestamps = this.sendTimestamps.filter((timestamp) => timestamp > windowStart);
    if (this.sendTimestamps.length >= RATE_LIMIT_MAX_PER_WINDOW) {
      return false;
    }
    this.sendTimestamps.push(now);
    return true;
  }

  /**
   * Deliberately never reads `error.message` or `error.url` — both may embed
   * the request URL, and the bot token lives in that URL's path. Only the
   * stable, tokenless fields are surfaced.
   */
  private describeSendFailure(error: unknown): string {
    if (isEgressError(error)) {
      return error.addressReason ? `${error.code} (${error.addressReason})` : error.code;
    }
    return error instanceof Error ? error.constructor.name : 'UnknownError';
  }

  /**
   * Second, independent guard: strips the literal bot token out of any
   * string before it reaches the logger, regardless of how it got there.
   * `redact()` in `src/shared/observability/redact.ts` only redacts by key
   * name on structured objects and cannot see a token embedded in free text.
   */
  private redactToken(text: string): string {
    return redactBotToken(text, this.config.botToken);
  }
}

/** Exported for the test to exercise directly without a live sink. */
export function redactBotToken(text: string, token: string | undefined): string {
  if (!token) {
    return text;
  }
  return text.split(token).join('[REDACTED_TELEGRAM_TOKEN]');
}

function toMessageText(alert: Alert): string {
  const icon =
    alert.severity === AlertSeverity.CRITICAL
      ? '\u{1F6A8}' // rotating light
      : alert.severity === AlertSeverity.WARN
        ? '\u{26A0}\u{FE0F}' // warning
        : '\u{2139}\u{FE0F}'; // information

  const detailLine = Object.entries(alert.details)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');

  const text = `${icon} [${alert.severity}] ${alert.name}\n${alert.summary}${
    detailLine ? `\n${detailLine}` : ''
  }`;

  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}… [truncated]` : text;
}
