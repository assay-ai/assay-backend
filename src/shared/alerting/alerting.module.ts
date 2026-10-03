import { Global, Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';

import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';
import { NetworkModule } from '@shared/network/network.module';

import { ALERT_PORT, AlertSeverity } from './alert.port';
import { FanOutAlertSink } from './fan-out-alert.sink';
import { LoggingAlertSink } from './logging-alert.sink';
import { SuppressingAlertSink } from './suppressing-alert.sink';
import {
  TELEGRAM_ALERT_SINK_CONFIG,
  TelegramAlertSink,
  TelegramAlertSinkConfig,
} from './telegram-alert.sink';
import {
  WEBHOOK_ALERT_SINK_CONFIG,
  WebhookAlertSink,
  WebhookAlertSinkConfig,
} from './webhook-alert.sink';

const webhookAlertSinkConfigFactory = (configService: ConfigService): WebhookAlertSinkConfig => ({
  enabled: configService.get<boolean>('observability.webhook.enabled') ?? false,
  urlBySeverity: {
    [AlertSeverity.CRITICAL]: configService.get<string>(
      'observability.webhook.urlBySeverity.CRITICAL',
    ),
    [AlertSeverity.WARN]: configService.get<string>('observability.webhook.urlBySeverity.WARN'),
    [AlertSeverity.INFO]: configService.get<string>('observability.webhook.urlBySeverity.INFO'),
  },
  minSeverity:
    (configService.get<string>('observability.webhook.minSeverity') as AlertSeverity) ??
    AlertSeverity.WARN,
  timeoutMs: configService.get<number>('observability.webhook.timeoutMs') ?? 5000,
});

const telegramAlertSinkConfigFactory = (configService: ConfigService): TelegramAlertSinkConfig => ({
  enabled: configService.get<boolean>('observability.telegram.enabled') ?? false,
  botToken: configService.get<string>('observability.telegram.botToken'),
  chatId: configService.get<string>('observability.telegram.chatId'),
  messageThreadId: configService.get<number>('observability.telegram.messageThreadId'),
  minSeverity:
    (configService.get<string>('observability.telegram.minSeverity') as AlertSeverity) ??
    AlertSeverity.WARN,
  timeoutMs: configService.get<number>('observability.telegram.timeoutMs') ?? 5000,
});

const alertPortFactory = (
  logging: LoggingAlertSink,
  webhook: WebhookAlertSink,
  telegram: TelegramAlertSink,
  redis: Redis,
): FanOutAlertSink =>
  // Logging sits outside the suppression check on purpose — see
  // `SuppressingAlertSink`'s class comment. Only the paging sinks
  // (webhook + Telegram) are deduplicated, and deduplicated together, so an
  // `ONCE_PER_INCIDENT` alert cannot page over one channel and stay silent on
  // the other depending on which sink's own check ran first.
  new FanOutAlertSink([
    logging,
    new SuppressingAlertSink(new FanOutAlertSink([webhook, telegram]), redis),
  ]);

const providers: Provider[] = [
  LoggingAlertSink,
  WebhookAlertSink,
  TelegramAlertSink,
  {
    provide: WEBHOOK_ALERT_SINK_CONFIG,
    inject: [ConfigService],
    useFactory: webhookAlertSinkConfigFactory,
  },
  {
    provide: TELEGRAM_ALERT_SINK_CONFIG,
    inject: [ConfigService],
    useFactory: telegramAlertSinkConfigFactory,
  },
  {
    provide: ALERT_PORT,
    inject: [LoggingAlertSink, WebhookAlertSink, TelegramAlertSink, REDIS_CACHE_CLIENT],
    useFactory: alertPortFactory,
  },
];

/**
 * `ALERT_PORT`, available everywhere.
 *
 * `@Global()` for the same reason `PostgresModule` is: alerting is not a
 * dependency any one domain owns, and a domain that has to remember to import
 * an alerting module in order to report a problem will eventually not import
 * it and report the problem to a logger instead.
 *
 * `ALERT_PORT` resolves to a {@link FanOutAlertSink} over
 * {@link LoggingAlertSink} (always) and a {@link SuppressingAlertSink} wrapping
 * a second {@link FanOutAlertSink} of {@link WebhookAlertSink} (only posts
 * when `ALERT_WEBHOOK_ENABLED=true`, and is otherwise an inert no-op) and
 * {@link TelegramAlertSink} (only posts when `ALERT_TELEGRAM_ENABLED=true`
 * **and** `ALERT_TELEGRAM_CHAT_ID` is set — the chat id starts empty because
 * a Telegram bot cannot start a conversation, and stays a no-op until a human
 * messages the bot) rather than to any one sink alone — a reconciler alert
 * must reach a human, not that it stop
 * reaching the log. The suppression wrapper is why an `ONCE_PER_INCIDENT`
 * alert pages once instead of once per cron pass — see
 * `SuppressingAlertSink`'s class comment for why logging sits outside it. See
 * `src/config/observability.config.ts` for the env surface,
 * `webhook-alert.sink.ts` for why the webhook call runs under
 * `UNTRUSTED_EGRESS_POLICY`, and `telegram-alert.sink.ts` for the same
 * reasoning plus why the bot token can never reach a log line.
 */
@Global()
@Module({
  imports: [NetworkModule],
  providers,
  exports: [ALERT_PORT],
})
export class AlertingModule {}
