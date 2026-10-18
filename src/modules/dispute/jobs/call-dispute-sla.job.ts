import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { CallDisputeSlaService } from '../services/call-dispute-sla.service';

/** Every five minutes: the call-dispute decision SLA (G3.B1). */
@Injectable()
export class CallDisputeSlaJob {
  private readonly logger = new Logger(CallDisputeSlaJob.name);

  constructor(private readonly sla: CallDisputeSlaService) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { waitForCompletion: true })
  async handleCallDisputeSla(): Promise<void> {
    try {
      await this.sla.sweep();
    } catch (error) {
      this.logger.error(
        `Call dispute SLA sweep threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
