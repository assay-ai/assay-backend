import { Injectable, Logger } from '@nestjs/common';

import { Alert, AlertPort, AlertSeverity } from './alert.port';

/**
 * The default sink: structured lines on the application logger.
 *
 * It is a complete implementation rather than a stub — the reconciler is
 * useless without somewhere to shout, and a reconciler that computes a breach
 * and returns it to nobody is worse than none. A log line at `error` with every
 * figure inline is enough for a log-based alerting rule to page on.
 *
 * `details` is rendered as `key=value` pairs on the same line, so the numbers
 * survive into whatever indexes the logs. The logging rules forbid
 * response bodies, key material and session tokens in logs; nothing reaches
 * this class that contains any of them, and callers must keep it that way —
 * `details` is for amounts, ids and counts.
 */
@Injectable()
export class LoggingAlertSink implements AlertPort {
  private readonly logger = new Logger('Alert');

  emit(alert: Alert): Promise<void> {
    const line = `[${alert.severity}] ${alert.name}: ${alert.summary}${format(alert.details)}`;

    switch (alert.severity) {
      case AlertSeverity.CRITICAL:
        this.logger.error(line);
        break;
      case AlertSeverity.WARN:
        this.logger.warn(line);
        break;
      default:
        this.logger.log(line);
    }

    return Promise.resolve();
  }
}

function format(details: Readonly<Record<string, string | number>>): string {
  const pairs = Object.entries(details);
  return pairs.length === 0 ? '' : ` — ${pairs.map(([k, v]) => `${k}=${v}`).join(' ')}`;
}
