import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { CallDisputeRetentionService } from '../services/call-dispute-retention.service';

/** Hourly: delete the bodies of decided call disputes' snapshots past retention. */
@Injectable()
export class CallDisputeRetentionJob {
  private readonly logger = new Logger(CallDisputeRetentionJob.name);

  constructor(private readonly retention: CallDisputeRetentionService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleCallDisputeRetention(): Promise<void> {
    try {
      await this.retention.sweep();
    } catch (error) {
      this.logger.error(
        `Call dispute retention sweep failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
