import { Logger } from '@nestjs/common';

import { Alert, AlertPort } from './alert.port';

/**
 * Compose sinks rather than choose one.
 *
 * `ALERT_PORT` used to resolve to `LoggingAlertSink` alone. Adding
 * `WebhookAlertSink` must not turn that into a swap — a dead webhook
 * endpoint, or `ALERT_WEBHOOK_ENABLED=false`, must never cost the log line an
 * alert already had. So `emit` runs every sink and always writes to all of
 * them, in parallel, and a sink that fails does not stop the others from
 * running: `AlertPort` says implementations must not throw, but this class
 * does not trust that promise blindly, because the one thing worse than an
 * alert that fails to page is an alert that fails to page *and* fails to
 * log, silently, because the sink ahead of it in an array threw first.
 */
export class FanOutAlertSink implements AlertPort {
  private readonly logger = new Logger(FanOutAlertSink.name);

  constructor(private readonly sinks: readonly AlertPort[]) {}

  async emit(alert: Alert): Promise<void> {
    await Promise.all(
      this.sinks.map(async (sink) => {
        try {
          await sink.emit(alert);
        } catch (error) {
          // A contract violation, not an expected path: `AlertPort.emit`
          // "must not throw." Caught anyway so one misbehaving sink cannot
          // take the others down with it.
          this.logger.error(
            `${sink.constructor.name} threw despite the AlertPort contract while emitting ` +
              `${alert.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  }
}
