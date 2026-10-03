import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import { Alert, AlertAggregation, AlertPort } from './alert.port';

/** One suppression marker per `(name, dedupeKey)`. */
export const ALERT_SUPPRESSION_KEY_PREFIX = 'alert:suppress:';

/**
 * `ONCE_PER_INCIDENT`'s window: one page, then silence for an hour before the
 * same condition can page again. Same value and the same reasoning as
 * `NOTIFICATION_INCIDENT_WINDOW_SECONDS` — long enough that a still-open
 * incident does not retrigger while someone is paged and reading it, short
 * enough that a genuinely new occurrence is not swallowed by the old one's
 * silence.
 */
export const ALERT_INCIDENT_WINDOW_SECONDS = 60 * 60;

/**
 * Wraps a downstream `AlertPort` — the paging sinks, Telegram and the
 * webhook — with a suppression check for `ONCE_PER_INCIDENT` alerts, so a
 * condition that is still true on the next cron pass or the next signing
 * request pages once, not once per pass.
 *
 * `LoggingAlertSink` must never sit behind this: `FanOutAlertSink`'s own
 * class comment promises that adding a paging sink never costs the log sink
 * an alert it already had, and a suppressed alert is, from the log's point of
 * view, an alert like any other. So this class wraps only the sinks a human
 * gets paged through, and `AlertingModule` is what keeps logging outside it.
 *
 * Same "fail toward sending" rule as `NotificationService.isSuppressed` (read
 * that doc first): a Redis outage must not silence a real page, so an
 * unreadable suppression check resolves to "not suppressed" and forwards.
 */
@Injectable()
export class SuppressingAlertSink implements AlertPort {
  private readonly logger = new Logger(SuppressingAlertSink.name);

  constructor(
    private readonly downstream: AlertPort,
    @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis,
  ) {}

  async emit(alert: Alert): Promise<void> {
    if ((alert.aggregation ?? AlertAggregation.PER_EVENT) === AlertAggregation.PER_EVENT) {
      await this.downstream.emit(alert);
      return;
    }

    if (await this.isSuppressed(alert)) {
      this.logger.debug(`${alert.name} suppressed (dedupeKey=${alert.dedupeKey ?? '(none)'})`);
      return;
    }

    await this.downstream.emit(alert);
  }

  private async isSuppressed(alert: Alert): Promise<boolean> {
    const key = this.suppressionKey(alert);
    const window = windowSecondsOf(alert);
    try {
      // `SET key 1 NX EX ttl` — atomic test-and-set, one round trip. `OK`
      // claims the window and the alert proceeds; `null` means a previous
      // call already claimed it.
      const claimed = await this.redis.set(key, '1', 'EX', window, 'NX');
      return claimed === null;
    } catch (error) {
      this.logger.warn(
        `Suppression check unreadable for ${alert.name}; sending. ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private suppressionKey(alert: Alert): string {
    return `${ALERT_SUPPRESSION_KEY_PREFIX}${alert.name}:${alert.dedupeKey ?? 'default'}`;
  }
}

/**
 * The alert's own window when it names one, the default otherwise.
 *
 * A non-integer or non-positive value degrades to the default rather than
 * reaching Redis: `EX 0` and `EX -1` are errors, and this sink's whole job is
 * to not be the reason an alert failed to send.
 */
function windowSecondsOf(alert: Alert): number {
  const requested = alert.suppressionWindowSeconds;
  return requested !== undefined && Number.isInteger(requested) && requested > 0
    ? requested
    : ALERT_INCIDENT_WINDOW_SECONDS;
}
