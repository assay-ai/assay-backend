import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PAYMENT_KEY_DAILY_SUMMARY_CRON } from '../constants/payment-key-daily-summary.constants';
import { PaymentKeyDailySummaryService } from '../services/payment-key-daily-summary.service';

/**
 * The cron wrapper around `PaymentKeyDailySummaryService.run`, daily at
 * 00:20 UTC for the UTC day before.
 *
 * Registered only in `AccountSchedulerModule`, which only the scheduler
 * process imports. The service's Redis lock keeps a second scheduler replica
 * from running it twice, and the notice is once per organization per day.
 */
@Injectable()
export class PaymentKeyDailySummaryJob {
  private readonly logger = new Logger(PaymentKeyDailySummaryJob.name);

  constructor(private readonly summary: PaymentKeyDailySummaryService) {}

  @Cron(PAYMENT_KEY_DAILY_SUMMARY_CRON, { timeZone: 'UTC', waitForCompletion: true })
  async handlePaymentKeyDailySummary(): Promise<void> {
    try {
      const result = await this.summary.run();
      if (!('day' in result)) {
        this.logger.log('Payment-key daily summary: skipped, another run holds the lock');
        return;
      }
      this.logger.log(
        `Payment-key daily summary for ${result.day}: organizations=${result.organizations} ` +
          `keys=${result.keys}`,
      );
    } catch (error) {
      this.logger.error(
        `Payment-key daily summary failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
