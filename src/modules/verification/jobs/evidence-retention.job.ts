import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { EvidenceRetentionService } from '../services/evidence-retention.service';

/**
 * The cron wrapper around `EvidenceRetentionService.sweep`.
 *
 * Hourly, and registered only in `VerificationSchedulerModule`, which only the
 * scheduler process imports — the same shape as `StakeMonitorJob` and for the
 * same reason (`docs/architecture.md` §Scaling Design): N API replicas each
 * running this would each delete the same batch and each log a different count
 * of the same work.
 *
 * Hourly rather than by the minute because the deadline is 72 hours: an
 * overshoot of up to an hour on a three-day promise is not a breach worth
 * paying for with a sweep every minute, and a body deleted an hour early would
 * be.
 *
 * The handler cannot throw. `sweep()` catches each half internally and the
 * catch below covers anything left — a cron handler that rejects is logged by
 * Nest and then forgotten, which is exactly how a retention promise quietly
 * stops being kept.
 */
@Injectable()
export class EvidenceRetentionJob {
  private readonly logger = new Logger(EvidenceRetentionJob.name);

  @Cron(CronExpression.EVERY_HOUR)
  async handleEvidenceRetention(): Promise<void> {
    try {
      await this.retention.sweep();
    } catch (error) {
      this.logger.error(
        `Evidence retention sweep threw past its own error handling: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  constructor(private readonly retention: EvidenceRetentionService) {}
}
