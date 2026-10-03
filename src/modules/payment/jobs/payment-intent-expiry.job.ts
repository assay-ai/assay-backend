import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PAYMENT_INTENT_EXPIRY_SWEEP_CRON } from '../constants/payment-intent.constants';
import { PaymentIntentExpiryService } from '../services/payment-intent-expiry.service';

/**
 * The cron wrapper around the expiry sweep, and nothing else.
 *
 * The sweep itself is a plain service so it can be driven from a test — and,
 * later, from an operator endpoint — without a scheduler in the picture. The
 * only thing that lives here is *when* it runs.
 *
 * A nonzero expiry rate in production means something upstream is broken, which
 * is why the sweep logs a line whenever it does any work at all.
 */
@Injectable()
export class PaymentIntentExpiryJob {
  private readonly logger = new Logger(PaymentIntentExpiryJob.name);

  constructor(private readonly expiry: PaymentIntentExpiryService) {}

  @Cron(PAYMENT_INTENT_EXPIRY_SWEEP_CRON)
  async handleExpirySweep(): Promise<void> {
    try {
      await this.expiry.sweep();
    } catch (error) {
      // A throw out of a @Cron handler is an unhandled rejection that takes the
      // scheduler process with it, and the next pass would never run.
      this.logger.error(
        `Expiry sweep pass aborted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
