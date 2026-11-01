import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

/** Refunds above this share of what went into hold in the hour page (basis points). */
export const DEFAULT_REFUND_ANOMALY_SHARE_BPS = 2_000;
/** …and above this amount (atomic, a 6-decimal settlement asset: $5). */
export const DEFAULT_REFUND_ANOMALY_MIN_ATOMIC = 5_000_000n;
const WINDOW_SECONDS = 3_600;

export interface RefundAnomalyPolicy {
  readonly shareBps: number;
  readonly minAtomic: bigint;
}

export function loadRefundAnomalyPolicy(env: NodeJS.ProcessEnv = process.env): RefundAnomalyPolicy {
  const share = env.REFUND_ANOMALY_SHARE_BPS;
  const min = env.REFUND_ANOMALY_MIN_ATOMIC;
  if (share !== undefined && share !== '' && (!/^\d+$/.test(share) || Number(share) > 10_000)) {
    throw new Error(`REFUND_ANOMALY_SHARE_BPS must be an integer from 0 to 10000, got "${share}"`);
  }
  if (min !== undefined && min !== '' && !/^\d{1,18}$/.test(min)) {
    throw new Error(`REFUND_ANOMALY_MIN_ATOMIC must be a non-negative integer, got "${min}"`);
  }
  return {
    shareBps: share ? Number(share) : DEFAULT_REFUND_ANOMALY_SHARE_BPS,
    minAtomic: min ? BigInt(min) : DEFAULT_REFUND_ANOMALY_MIN_ATOMIC,
  };
}

/**
 * The refund-volume anomaly (SPEC-W2 §7), per provider and asset per hour:
 * refunds out of the dispute hold (both doors) above `REFUND_ANOMALY_SHARE_BPS`
 * of what went into the hold in the hour AND above `REFUND_ANOMALY_MIN_ATOMIC`
 * page WARN. The redeemer key can refund any held money before it is
 * collected; a backend refunding far more than disputes explain is what a
 * compromised one would look like, and is also how a provider's real quality
 * collapse looks — either way a person should see it. Read only, from the
 * booking columns; one page per provider per hour.
 */
@Injectable()
export class RefundAnomalyMonitor {
  private readonly logger = new Logger(RefundAnomalyMonitor.name);

  constructor(
    private readonly payments: PaymentIntentRepository,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Optional() private readonly policy: RefundAnomalyPolicy = loadRefundAnomalyPolicy(),
    @Optional() private readonly now: () => number = () => Date.now(),
  ) {}

  @Cron('40 */10 * * * *', { waitForCompletion: true })
  async tick(): Promise<void> {
    try {
      await this.check();
    } catch (error) {
      this.logger.warn(
        `refund anomaly check failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** The providers paged this pass. */
  async check(): Promise<string[]> {
    const paged: string[] = [];
    const hour = Math.floor(this.now() / 3_600_000);
    for (const row of await this.payments.refundVolumeByProvider(WINDOW_SECONDS)) {
      if (row.refunded <= this.policy.minAtomic) continue;
      const base = row.held > 0n ? row.held : 1n;
      if (row.refunded * 10_000n <= base * BigInt(this.policy.shareBps)) continue;
      paged.push(row.providerId);
      await this.alerts.emit({
        severity: AlertSeverity.WARN,
        name: 'provider_refund_volume_anomaly',
        summary:
          `Provider ${row.providerId} on ${row.assetId}: ${row.refunds} refund(s) out of the dispute ` +
          `hold totalling ${row.refunded} in the last hour against ${row.held} held — above ` +
          `${this.policy.shareBps / 100}% and ${this.policy.minAtomic}. Check the disputes behind them.`,
        details: {
          providerId: row.providerId,
          assetId: row.assetId,
          refunded: row.refunded.toString(),
          held: row.held.toString(),
          refunds: row.refunds,
        },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: `${row.providerId}:${row.assetId}:${hour}`,
      });
    }
    return paged;
  }
}
