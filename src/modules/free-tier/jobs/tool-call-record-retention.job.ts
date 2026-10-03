import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { ToolCallRecordRetentionService } from '../services/tool-call-record-retention.service';

/**
 * The cron wrapper around `ToolCallRecordRetentionService.sweep`.
 *
 * Hourly, registered only in the scheduler process's module — same shape as
 * `EvidenceRetentionJob`, `StakeMonitorJob` and every other cron on this
 * platform, and the same reason: N API replicas each running this would each
 * delete the same batch and each log a different count of the same work.
 *
 * Hourly rather than by the minute because free traffic is expected to be the
 * platform's highest-volume traffic and the
 * retention promise is measured in days, not minutes — an overshoot of up to
 * an hour on a 30-day promise is not worth a sweep every minute.
 *
 * The handler cannot throw. `sweep()` catches its own failure internally, and
 * the catch below covers anything left, for the reason `EvidenceRetentionJob`
 * states: a cron handler that rejects is logged by Nest and then forgotten,
 * which is exactly how a retention promise quietly stops being kept.
 */
@Injectable()
export class ToolCallRecordRetentionJob {
  private readonly logger = new Logger(ToolCallRecordRetentionJob.name);

  constructor(private readonly retention: ToolCallRecordRetentionService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleToolCallRecordRetention(): Promise<void> {
    try {
      await this.retention.sweep();
    } catch (error) {
      this.logger.error(
        `Free-tier retention sweep threw past its own error handling: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
