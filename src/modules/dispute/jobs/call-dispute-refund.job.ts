import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { CallDisputeSlaService } from '../services/call-dispute-sla.service';

/**
 * Every minute, at second 45 (off the redemption and collection passes on the
 * shared redeemer key): send the refunds of upheld disputes (review P1-2).
 */
@Injectable()
export class CallDisputeRefundJob {
  private readonly logger = new Logger(CallDisputeRefundJob.name);

  constructor(private readonly sla: CallDisputeSlaService) {}

  @Cron('45 * * * * *', { waitForCompletion: true })
  async handleCallDisputeRefunds(): Promise<void> {
    try {
      await this.sla.refundPending();
    } catch (error) {
      this.logger.error(
        `Call dispute refunds threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
