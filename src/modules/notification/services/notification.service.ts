import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { NotificationChannelRepository } from '@database/postgres/repositories/notification-channel.repository';
import { NotificationDeliveryRepository } from '@database/postgres/repositories/notification-delivery.repository';
import { NotificationPreferenceRepository } from '@database/postgres/repositories/notification-preference.repository';
import { NotificationRepository } from '@database/postgres/repositories/notification.repository';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import {
  NOTIFICATION_CATALOGUE,
  NOTIFICATION_INCIDENT_WINDOW_SECONDS,
  NOTIFICATION_ONCE_TTL_SECONDS,
  NotificationDefinition,
} from '../constants/notification-catalogue';
import {
  NotificationAggregation,
  NotificationChannel,
  NotificationOutcome,
  NotificationPort,
  NotificationRequest,
} from '../ports/notification.port';
import { NotificationDeliverPublisher } from '../publishers/notification-deliver.publisher';

/** One sorted-set-free suppression marker per `(organization, event, dedupeKey[, period])`. */
export const NOTIFICATION_SUPPRESSION_KEY_PREFIX = 'notification:suppress:';

type ChannelDecision =
  | { readonly channel: NotificationChannel; readonly status: 'DELIVERED' }
  | { readonly channel: NotificationChannel; readonly status: 'PENDING' }
  | { readonly channel: NotificationChannel; readonly status: 'SUPPRESSED' };

/**
 * `NotificationPort`'s implementation — the fan-out, the
 * suppression and the one durable write, in the order `notify`'s own
 * interface doc requires.
 *
 * ## Fail toward sending
 *
 * The aggregation check (step 2 of `notify`) is a Redis `SET … NX EX`. If
 * Redis cannot answer, the notification is **sent** rather than suppressed —
 * the opposite of `RedisSigningRateLimiter`'s rule, and for the opposite
 * reason `BindingCeilingService` gives for its own permit-on-failure choice:
 * this class guards a customer's inbox, not money. A notification storm
 * during a Redis outage costs a user some noise; going silent during one
 * means a real balance-zero or a real withdrawal never reaches them, and *
 * that* is the failure this system exists to prevent. So every suppression
 * check is wrapped, and every failure resolves to "not suppressed" rather
 * than to "suppressed".
 *
 * ## Never throws
 *
 * Same rule as `AlertPort`, restated for this port's own doc comment: a
 * producer's business logic (a ledger write, a stake sweep) must complete
 * whether or not telling the customer about it succeeds. `notify` therefore
 * wraps its entire body and reports failures to the log, never to the caller.
 */
@Injectable()
export class NotificationService implements NotificationPort {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly notifications: NotificationRepository,
    private readonly channels: NotificationChannelRepository,
    private readonly preferences: NotificationPreferenceRepository,
    private readonly deliveries: NotificationDeliveryRepository,
    private readonly publisher: NotificationDeliverPublisher,
    @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis,
  ) {}

  async notify(request: NotificationRequest): Promise<NotificationOutcome> {
    try {
      return await this.doNotify(request);
    } catch (error) {
      this.logger.error(
        `notify(${request.event}) for org ${request.organizationId} failed: ${describe(error)}`,
      );
      // The "never throws" contract is unchanged. A caller that starts a clock
      // on delivery must not start one when the notification did not happen,
      // so a swallowed failure reports nothing delivered.
      return { deliveredNow: false };
    }
  }

  private async doNotify(request: NotificationRequest): Promise<NotificationOutcome> {
    const definition = NOTIFICATION_CATALOGUE[request.event];

    // Step 1 — `DIGEST_ONLY` writes nothing and is not an error.
    if (definition.aggregation === NotificationAggregation.DIGEST_ONLY) {
      this.logger.debug(`${request.event} is DIGEST_ONLY; not delivered individually`);
      return { deliveredNow: false };
    }

    // Step 2 — the aggregation rule, as a suppression check.
    const suppressed = await this.isSuppressed(request, definition);
    if (suppressed) {
      this.logger.debug(
        `${request.event} suppressed for org ${request.organizationId} (dedupeKey=${request.dedupeKey ?? '(none)'})`,
      );
      // An outcome, never `undefined`: callers read `deliveredNow` off it, and
      // `SlashProposalService` does so on the path that starts the response clock.
      return { deliveredNow: false };
    }

    // Step 3 — the one durable row.
    const notificationId = randomUUID();
    const severity = request.severity ?? definition.severity;

    // Step 4 — resolve the fan-out.
    const decisions = await this.resolveFanout(request.organizationId, request.event, definition);
    const deliveredNow = decisions.some((decision) => decision.status === 'DELIVERED');

    await this.notifications.insert({
      id: notificationId,
      organizationId: request.organizationId,
      event: request.event,
      severity,
      title: request.title,
      body: request.body,
      subjectType: request.subjectType ?? null,
      subjectId: request.subjectId ?? null,
      payload: request.payload ?? {},
      readAt: null,
      firstDeliveredAt: deliveredNow ? new Date() : null,
    });

    // Step 5 — one delivery row per catalogue channel. Ids are assigned here,
    // before the insert, so step 6 can enqueue against them without a second
    // round trip to re-read what was just written.
    const now = new Date();
    const rows = decisions.map((decision) => ({
      id: randomUUID(),
      organizationId: request.organizationId,
      notificationId,
      channel: decision.channel,
      status: decision.status,
      attempts: 0,
      lastError: null,
      deliveredAt: decision.status === 'DELIVERED' ? now : null,
    }));
    await this.deliveries.insert(rows);

    // Step 6 — enqueue delivery for every non-`IN_APP` channel left `PENDING`.
    await Promise.all(
      rows
        .filter((row) => row.status === 'PENDING')
        .map((row) =>
          this.publisher.publishDeliver({
            organizationId: request.organizationId,
            notificationId,
            deliveryId: row.id,
            channel: row.channel,
          }),
        ),
    );

    return { deliveredNow };
  }

  // ── suppression (step 2) ────────────────────────────────────────────────

  private async isSuppressed(
    request: NotificationRequest,
    definition: NotificationDefinition,
  ): Promise<boolean> {
    if (definition.aggregation === NotificationAggregation.PER_EVENT) {
      return false;
    }

    const key = this.suppressionKey(request, definition.aggregation);
    const ttlSeconds = this.ttlFor(definition.aggregation);

    try {
      // `SET key 1 NX EX ttl` — atomic test-and-set, one round trip. `OK`
      // means this call claimed the window and the notification proceeds;
      // `null` means a previous call already claimed it and this one is
      // suppressed.
      const claimed = await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX');
      return claimed === null;
    } catch (error) {
      this.logger.warn(
        `Suppression check unreadable for ${request.event} (org ${request.organizationId}); sending. ${describe(error)}`,
      );
      return false;
    }
  }

  private suppressionKey(
    request: NotificationRequest,
    aggregation: NotificationAggregation,
  ): string {
    const grain = request.dedupeKey ?? 'org';
    const period = this.periodFor(aggregation);
    return (
      `${NOTIFICATION_SUPPRESSION_KEY_PREFIX}${request.organizationId}:${request.event}:${grain}` +
      (period ? `:${period}` : '')
    );
  }

  /** The UTC period suffix for the two calendar-scoped rules; `null` for the rest. */
  private periodFor(aggregation: NotificationAggregation): string | null {
    const now = new Date();
    switch (aggregation) {
      case NotificationAggregation.ONCE_PER_UTC_DAY:
        return now.toISOString().slice(0, 10); // YYYY-MM-DD
      case NotificationAggregation.ONCE_PER_UTC_MONTH:
        return now.toISOString().slice(0, 7); // YYYY-MM
      default:
        return null;
    }
  }

  private ttlFor(aggregation: NotificationAggregation): number {
    switch (aggregation) {
      case NotificationAggregation.ONCE_PER_INCIDENT:
        return NOTIFICATION_INCIDENT_WINDOW_SECONDS;
      case NotificationAggregation.ONCE:
        return NOTIFICATION_ONCE_TTL_SECONDS;
      case NotificationAggregation.ONCE_PER_UTC_DAY:
        // A day's key lives a little past the day it names, exactly the
        // reasoning `BindingCeilingService.secondsUntilNextUtcDay` gives for its
        // own daily bucket: a pod slightly behind UTC midnight must not get a
        // second window for the day that is, for it, still running.
        return secondsUntilNextUtcDay() + 3_600;
      case NotificationAggregation.ONCE_PER_UTC_MONTH:
        return secondsUntilNextUtcMonth() + 3_600;
      default:
        // PER_EVENT and DIGEST_ONLY never reach here.
        return NOTIFICATION_ONCE_TTL_SECONDS;
    }
  }

  // ── fan-out (step 4) ────────────────────────────────────────────────────

  private async resolveFanout(
    organizationId: string,
    event: string,
    definition: NotificationDefinition,
  ): Promise<ChannelDecision[]> {
    const [channelRows, preferenceRows] = await Promise.all([
      this.channels.findForOrganization(organizationId),
      this.preferences.findForEvent(organizationId, event),
    ]);

    const preferenceByChannel = new Map(preferenceRows.map((row) => [row.channel, row.enabled]));
    const channelRowByChannel = new Map(channelRows.map((row) => [row.channel, row]));

    return definition.channels.map((channel): ChannelDecision => {
      if (channel === NotificationChannel.IN_APP) {
        // Always available, no preference can switch it off — the dashboard
        // inbox is what the notification feed reads and the row already carries the content.
        return { channel, status: 'DELIVERED' };
      }

      const preferenceEnabled = preferenceByChannel.get(channel);
      if (preferenceEnabled === false && !definition.nonSuppressible) {
        return { channel, status: 'SUPPRESSED' };
      }

      const channelRow = channelRowByChannel.get(channel);
      if (!channelRow || !channelRow.enabled || !channelRow.destination) {
        // No configured, enabled destination — suppressed, not failed. A
        // `nonSuppressible` event cannot be forced through a destination that
        // does not exist; the preference guard above is what `nonSuppressible`
        // actually protects against.
        return { channel, status: 'SUPPRESSED' };
      }

      return { channel, status: 'PENDING' };
    });
  }
}

function secondsUntilNextUtcDay(): number {
  const now = Date.now();
  const midnight = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate() + 1,
  );
  return Math.ceil((midnight - now) / 1_000);
}

function secondsUntilNextUtcMonth(): number {
  const now = Date.now();
  const firstOfNextMonth = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth() + 1,
    1,
  );
  return Math.ceil((firstOfNextMonth - now) / 1_000);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
