import { validateConfig } from '@shared/utils/validate-config';
import { registerAs } from '@nestjs/config';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, ValidateIf } from 'class-validator';

/**
 * Delivery configuration for `src/shared/alerting/`.
 *
 * `LoggingAlertSink` needs no configuration — it always exists and always
 * writes to the process logger. This namespace configures the **second** hop,
 * `WebhookAlertSink`, which is the one that can actually reach a human who is
 * not tailing a log. Every variable here is optional except when
 * `ALERT_WEBHOOK_ENABLED=true`, following the same fail-fast shape as
 * `src/config/bullboard.config.ts`: a webhook that is on but has nowhere to
 * post is worse than one that never existed, because a deploy that "has
 * alerting" gets less scrutiny than one that visibly does not.
 */
class ObservabilityEnvVariables {
  @IsBoolean()
  @IsOptional()
  ALERT_WEBHOOK_ENABLED?: boolean;

  // Required only when the webhook is enabled. No default — a guessed
  // endpoint (e.g. localhost) would silently swallow every page.
  @ValidateIf((o) => o.ALERT_WEBHOOK_ENABLED === true || o.ALERT_WEBHOOK_ENABLED === 'true')
  @IsString({ message: 'ALERT_WEBHOOK_URL is required when ALERT_WEBHOOK_ENABLED=true' })
  ALERT_WEBHOOK_URL?: string;

  // Per-severity overrides. CRITICAL pages on-call and
  // WARN does not — two different channels/recipients is the normal way that
  // distinction is expressed in Slack-compatible tooling. Falls back to
  // `ALERT_WEBHOOK_URL` when unset, so a single-channel deployment needs only
  // one variable.
  @IsOptional()
  @IsString()
  ALERT_WEBHOOK_URL_CRITICAL?: string;

  @IsOptional()
  @IsString()
  ALERT_WEBHOOK_URL_WARN?: string;

  // The floor severity that reaches the webhook at all. Defaults to WARN:
  // every INFO-level alert still reaches the log (LoggingAlertSink never
  // filters), but forwarding INFO to a paging tool trains humans to ignore it.
  @IsOptional()
  @IsIn(['INFO', 'WARN', 'CRITICAL'])
  ALERT_WEBHOOK_MIN_SEVERITY?: string;

  // Bounds how long `WebhookAlertSink.emit` can block the caller. Deliberately
  // short relative to `DEFAULT_EGRESS_LIMITS.totalTimeoutMs` (30s) — an alert
  // sink exists to report a problem quickly, not to retry a dead endpoint
  // patiently while the thing it was reporting keeps happening.
  @IsOptional()
  @IsNumber()
  ALERT_WEBHOOK_TIMEOUT_MS?: number;

  // `TelegramAlertSink` — the internal on-call channel. Off by
  // default.
  @IsBoolean()
  @IsOptional()
  ALERT_TELEGRAM_ENABLED?: boolean;

  // Required only when Telegram alerting is enabled — without it there is no
  // way to ever call `sendMessage`, so this fails fast the same way
  // `ALERT_WEBHOOK_URL` does. Never logged: see
  // `src/shared/alerting/telegram-alert.sink.ts`'s class docstring for why
  // it cannot be kept out of a URL by omission the way a header token can.
  @ValidateIf((o) => o.ALERT_TELEGRAM_ENABLED === true || o.ALERT_TELEGRAM_ENABLED === 'true')
  @IsString({ message: 'ALERT_TELEGRAM_BOT_TOKEN is required when ALERT_TELEGRAM_ENABLED=true' })
  ALERT_TELEGRAM_BOT_TOKEN?: string;

  // Deliberately has NO fail-fast requirement even when Telegram alerting is
  // enabled: a Telegram bot cannot start a conversation, so this starts empty
  // until a human messages the bot first. `TelegramAlertSink` treats the
  // empty case as "not configured yet" — it logs once and degrades, the same
  // way `WebhookAlertSink` degrades when a severity has no URL. Do not add a
  // `@ValidateIf` here; that would turn "waiting for a human to message the
  // bot" into a boot-time crash.
  @IsOptional()
  @IsString()
  ALERT_TELEGRAM_CHAT_ID?: string;

  // The floor severity that reaches Telegram at all. Same default and same
  // reasoning as `ALERT_WEBHOOK_MIN_SEVERITY`.
  @IsOptional()
  @IsIn(['INFO', 'WARN', 'CRITICAL'])
  ALERT_TELEGRAM_MIN_SEVERITY?: string;

  /**
   * A forum topic id inside `ALERT_TELEGRAM_CHAT_ID`. Only meaningful when the
   * chat is a forum group; Telegram rejects it on any other chat, so it is
   * omitted from the request rather than sent empty.
   */
  @IsOptional()
  @IsString()
  ALERT_TELEGRAM_MESSAGE_THREAD_ID?: string;
}

const observabilityConfig = registerAs('observability', () => {
  validateConfig(process.env, ObservabilityEnvVariables);

  const enabled = process.env.ALERT_WEBHOOK_ENABLED === 'true';

  return {
    webhook: {
      enabled,
      url: process.env.ALERT_WEBHOOK_URL,
      urlBySeverity: {
        CRITICAL: process.env.ALERT_WEBHOOK_URL_CRITICAL || process.env.ALERT_WEBHOOK_URL,
        WARN: process.env.ALERT_WEBHOOK_URL_WARN || process.env.ALERT_WEBHOOK_URL,
        INFO: process.env.ALERT_WEBHOOK_URL,
      },
      minSeverity: process.env.ALERT_WEBHOOK_MIN_SEVERITY || 'WARN',
      timeoutMs: parseInt(process.env.ALERT_WEBHOOK_TIMEOUT_MS || '5000', 10),
    },
    telegram: {
      enabled: process.env.ALERT_TELEGRAM_ENABLED === 'true',
      botToken: process.env.ALERT_TELEGRAM_BOT_TOKEN,
      chatId: process.env.ALERT_TELEGRAM_CHAT_ID,
      minSeverity: process.env.ALERT_TELEGRAM_MIN_SEVERITY || 'WARN',
      messageThreadId: process.env.ALERT_TELEGRAM_MESSAGE_THREAD_ID
        ? Number(process.env.ALERT_TELEGRAM_MESSAGE_THREAD_ID)
        : undefined,
      // Fixed rather than a new env var — an alert sink exists to report a
      // problem quickly, not to retry a dead endpoint patiently. Same value
      // and reasoning as the webhook sink's default.
      timeoutMs: 5000,
    },
  };
});

export { observabilityConfig };
