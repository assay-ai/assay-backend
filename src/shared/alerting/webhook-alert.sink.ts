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

export interface WebhookAlertSinkConfig {
  readonly enabled: boolean;
  /** One destination per severity. A severity with no URL is dropped (logged, not sent). */
  readonly urlBySeverity: Readonly<Partial<Record<AlertSeverity, string>>>;
  /** Alerts below this severity never reach the webhook, only the log. */
  readonly minSeverity: AlertSeverity;
  /** Per-call ceiling. Bounds how long `emit` can block the caller. */
  readonly timeoutMs: number;
}

export const WEBHOOK_ALERT_SINK_CONFIG = 'WEBHOOK_ALERT_SINK_CONFIG';

/**
 * The off-platform sink: one outbound webhook call, Slack-compatible payload.
 *
 * ## Why `UNTRUSTED_EGRESS_POLICY` and not `INTERNAL_EGRESS_POLICY`
 *
 * `src/shared/network/egress/egress.policy.ts` reserves `INTERNAL_ALLOWED` for
 * exactly one situation: a URL that names one of *our own* services running on
 * a private address (the facilitator, Kora). Its own docstring says the
 * relaxation is about the address, not the source: "if you are reaching for
 * it for anything other than a value read from `process.env` at boot, the
 * answer is no" — and an alert webhook *is* read from `process.env` at boot,
 * which makes this look like a fit at first read.
 *
 * It is not one. A Slack-compatible webhook is a third-party public endpoint
 * — `hooks.slack.com` and equivalents resolve to public addresses, so
 * `PUBLIC_ONLY` never gets in the way of the legitimate case. What
 * `INTERNAL_ALLOWED` would additionally buy here is letting a *misconfigured*
 * `ALERT_WEBHOOK_URL` reach a private or loopback address without the guard
 * objecting — turning an operator typo (or a compromised config value) into
 * exactly the SSRF primitive the egress guard exists to close off, on the one outbound call in this
 * codebase that is deliberately reachable from a config value rather than a
 * database row. An operator-configured webhook is a lower-adversary source
 * than a provider-supplied URL, but it is not a *no*-adversary source, and
 * `PUBLIC_ONLY` costs this feature nothing to keep. So: still routed through
 * `EgressHttpClient` (nothing else may open a socket — `no-restricted-globals`
 * on `fetch` covers this file same as any other), still under `PUBLIC_ONLY`.
 *
 * ## Must not throw, must not block indefinitely
 *
 * Both requirements come from `AlertPort`'s own contract. `emit` never
 * rejects — every failure (refused config, transport error, non-2xx
 * response) is caught and logged, never re-thrown — and the outbound call
 * runs under a tightened `totalTimeoutMs` (`observability.webhook.timeoutMs`,
 * default 5s) rather than `DEFAULT_EGRESS_LIMITS`' 30s: an alert sink exists
 * to report a problem fast, not to patiently retry a dead endpoint while the
 * problem it was reporting keeps happening.
 *
 * ## Compose, don't replace
 *
 * This class does not write to the process logger on success — that is
 * `LoggingAlertSink`'s job, and `FanOutAlertSink` is what runs both. On
 * failure it logs a `warn` naming the alert so an operator watching logs can
 * tell "the webhook is broken" apart from "nothing happened" — but the alert
 * itself already reached the log through the other fan-out leg by the time
 * this one gives up.
 */
@Injectable()
export class WebhookAlertSink implements AlertPort {
  private readonly logger = new Logger(WebhookAlertSink.name);

  constructor(
    private readonly egress: EgressHttpClient,
    @Inject(WEBHOOK_ALERT_SINK_CONFIG) private readonly config: WebhookAlertSinkConfig,
  ) {}

  async emit(alert: Alert): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    if (SEVERITY_ORDER[alert.severity] < SEVERITY_ORDER[this.config.minSeverity]) {
      return;
    }

    const url = this.config.urlBySeverity[alert.severity];
    if (!url) {
      this.logger.warn(
        `No webhook URL configured for severity ${alert.severity}; ${alert.name} did not ` +
          'reach the webhook (the log line still stands)',
      );
      return;
    }

    try {
      const response = await this.egress.request({
        url,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toSlackPayload(alert)),
        policy: withLimits(UNTRUSTED_EGRESS_POLICY, { totalTimeoutMs: this.config.timeoutMs }),
      });

      if (response.status >= 300) {
        this.logger.warn(
          `Webhook refused ${alert.name}: HTTP ${response.status} ` +
            `${response.body.slice(0, 200)}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Webhook delivery failed for ${alert.name} (${describe(error)}); relying on the log line`,
      );
    }
  }
}

function toSlackPayload(alert: Alert): Record<string, unknown> {
  const icon =
    alert.severity === AlertSeverity.CRITICAL
      ? ':rotating_light:'
      : alert.severity === AlertSeverity.WARN
        ? ':warning:'
        : ':information_source:';

  const detailLine = Object.entries(alert.details)
    .map(([key, value]) => `*${key}*: ${value}`)
    .join('  ·  ');

  const text = `${icon} [${alert.severity}] *${alert.name}*\n${alert.summary}`;

  return {
    text: `[${alert.severity}] ${alert.name}: ${alert.summary}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      ...(detailLine ? [{ type: 'section', text: { type: 'mrkdwn', text: detailLine } }] : []),
    ],
  };
}

function describe(error: unknown): string {
  if (isEgressError(error)) {
    return `${error.code} ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
