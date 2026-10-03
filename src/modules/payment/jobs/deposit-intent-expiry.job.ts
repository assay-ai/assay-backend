import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { DEPOSIT_INTENT_EXPIRY_SWEEP_CRON } from '../constants/deposit-intent.constants';
import { DepositIntentExpiryService } from '../services/deposit-intent-expiry.service';

/** The cron wrapper around the deposit-intent expiry sweep. Mirrors `PaymentIntentExpiryJob`. */
@Injectable()
export class DepositIntentExpiryJob {
  private readonly logger = new Logger(DepositIntentExpiryJob.name);

  constructor(private readonly expiry: DepositIntentExpiryService) {}

  @Cron(DEPOSIT_INTENT_EXPIRY_SWEEP_CRON)
  async handleExpirySweep(): Promise<void> {
    try {
      await this.expiry.sweep();
    } catch (error) {
      this.logger.error(
        `Deposit expiry sweep pass aborted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
