import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import {
  DEBT_SPIKE_THRESHOLD,
  DEBT_SPIKE_WINDOW_SECONDS,
  VOUCHER_REDEMPTION_ALERTS,
} from '../constants/voucher-redemption.constants';

/**
 * The buyer-debt spike alert ({@link VOUCHER_REDEMPTION_ALERTS.DEBT_SPIKE}):
 * more than {@link DEBT_SPIKE_THRESHOLD} buyer debts of one asset created
 * within {@link DEBT_SPIKE_WINDOW_SECONDS}. A burst is what a platform failure
 * to redeem looks like; an operator reviews it and, if the platform caused it,
 * voids in bulk (`M-1`). Nothing is voided here.
 *
 * Called where debts are made — after a redemption pass that lapsed any, and
 * after the verdict-deadline sweep settled any as debt — and counted from the
 * table (`redemption_lapsed_at` in the window), so a restart loses nothing and
 * debts from both places count together. Deduplicated per asset per window by
 * the alert sink (`ONCE_PER_INCIDENT`, `dedupeKey` = asset), which holds
 * across processes and restarts. Never throws.
 */
@Injectable()
export class BuyerDebtSpikeMonitor {
  private readonly logger = new Logger(BuyerDebtSpikeMonitor.name);

  constructor(
    private readonly payments: PaymentIntentRepository,
    @Optional() @Inject(ALERT_PORT) private readonly alerts: AlertPort | null = null,
  ) {}

  /** Checks `assetId`, or every asset when omitted, as of `now`. */
  async check(now: Date, assetId?: string): Promise<void> {
    if (!this.alerts) return;
    try {
      const since = new Date(now.getTime() - DEBT_SPIKE_WINDOW_SECONDS * 1000);
      const counts = await this.payments.countDebtsLapsedSince(since, assetId);
      for (const { assetId: asset, count } of counts) {
        if (count <= DEBT_SPIKE_THRESHOLD) continue;
        await this.alerts.emit({
          severity: AlertSeverity.CRITICAL,
          name: VOUCHER_REDEMPTION_ALERTS.DEBT_SPIKE,
          summary:
            `${count} served calls of ${asset} became buyer debt within ` +
            `${DEBT_SPIKE_WINDOW_SECONDS / 60} minutes — check the redeemer (float, RPC, pause) ` +
            `and the verification worker. If the platform caused it, void the debts in bulk ` +
            `from the operator debt page`,
          details: {
            asset,
            debts: count,
            threshold: DEBT_SPIKE_THRESHOLD,
            windowSeconds: DEBT_SPIKE_WINDOW_SECONDS,
          },
          aggregation: AlertAggregation.ONCE_PER_INCIDENT,
          dedupeKey: asset,
          suppressionWindowSeconds: DEBT_SPIKE_WINDOW_SECONDS,
        });
      }
    } catch (error) {
      this.logger.warn(
        `Buyer-debt spike check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
