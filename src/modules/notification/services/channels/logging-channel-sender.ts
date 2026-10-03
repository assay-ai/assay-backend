import { Injectable, Logger } from '@nestjs/common';

import {
  NotificationChannelSender,
  NotificationDeliveryJob,
  NotificationDeliveryResult,
} from '../../ports/notification-channel-sender.port';

/**
 * The stand-in for `EMAIL` / `PUSH` / `SLACK` / `WEBHOOK`.
 *
 * **This is a placeholder, and this comment is the one place that is allowed
 * to say so — no other comment or DTO in this codebase may claim a
 * notification reaches a human off-platform.** There is no vendor
 * integration behind any of the four channels this class stands in for: no
 * SMTP client, no push provider, no Slack app, no outbound HTTP call. It logs
 * what it would have sent and reports `delivered: true`, so the rest of the
 * pipeline — the delivery row, the retry policy, the settings screens — can be
 * built and tested end to end before a real sender exists behind any of them.
 *
 * Until a real sender replaces this for a given channel, **no notification on
 * that channel reaches anyone outside the platform**, regardless of what
 * `notification_deliveries.status` says. `DELIVERED` here means "the platform
 * finished its side of the attempt", not "a person read it" — the same gap
 * an unbuilt webhook signer would leave.
 *
 * What a real sender needs, per channel, before it can replace this class:
 *
 * - **`EMAIL`** — an SMTP/API provider account (SES, Postmark, …), and the
 *   destination on `notification_channels.destination` must be
 *   `verified_at`-checked before it is used, per that entity's own class
 *   comment.
 * - **`PUSH`** — a registered push provider (APNs/FCM or an aggregator) and a
 *   device token as the destination, which nothing in this schema issues yet.
 * - **`SLACK`** — an installed Slack app with a bot token or an incoming
 *   webhook URL as the destination, and a workspace-level OAuth flow this
 *   module does not have.
 * - **`WEBHOOK`** — HMAC signing of the outbound body, plus retry-with-backoff
 *   against a customer endpoint that may be down; none of that exists here.
 */
@Injectable()
export class LoggingChannelSender implements NotificationChannelSender {
  private readonly logger = new Logger(LoggingChannelSender.name);

  async send(job: NotificationDeliveryJob): Promise<NotificationDeliveryResult> {
    this.logger.log(
      `[placeholder ${job.channel}] would deliver notification ${job.notificationId} ` +
        `to org ${job.organizationId}${job.destination ? ` at ${job.destination}` : ''}: ` +
        `"${job.title}"`,
    );
    return { delivered: true };
  }
}
