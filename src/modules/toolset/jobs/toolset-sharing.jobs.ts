import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ToolsetModerationService } from '../services/toolset-moderation.service';
import { ToolsetStatsService } from '../services/toolset-stats.service';

/** Every 15 minutes: expired grace periods and unconfirmed cutoffs. */
export const TOOLSET_SWEEP_CRON = '*/15 * * * *';
/** Nightly, 00:30 UTC: the daily raw windows. */
export const TOOLSET_STATS_DAILY_CRON = '30 0 * * *';
/** Monday 00:00 UTC: the weekly publication (design spec §7.8). */
export const TOOLSET_STATS_WEEKLY_CRON = '0 0 * * 1';

/**
 * The publishing half's cron wrappers. Registered only in
 * `ToolsetSchedulerModule`, which only the scheduler process imports, so each
 * runs once per deployment. Every schedule is UTC (the scheduler process runs
 * with `TZ=UTC`; `timeZone` is pinned as well).
 */
@Injectable()
export class ToolsetSharingJobs {
  private readonly logger = new Logger(ToolsetSharingJobs.name);

  constructor(
    private readonly moderation: ToolsetModerationService,
    private readonly stats: ToolsetStatsService,
  ) {}

  @Cron(TOOLSET_SWEEP_CRON, { timeZone: 'UTC' })
  async sweep(): Promise<void> {
    await this.guard('sweep', async () => {
      const reverted = await this.moderation.revertExpired();
      const expired = await this.moderation.expireGrace();
      if (reverted || expired) {
        this.logger.log(`cutoffs reverted=${reverted} grace periods ended=${expired}`);
      }
    });
  }

  @Cron(TOOLSET_STATS_DAILY_CRON, { timeZone: 'UTC' })
  async daily(): Promise<void> {
    await this.guard('daily stats', () => this.stats.runDaily().then(() => undefined));
  }

  @Cron(TOOLSET_STATS_WEEKLY_CRON, { timeZone: 'UTC' })
  async weekly(): Promise<void> {
    await this.guard('weekly stats', () => this.stats.runWeekly().then(() => undefined));
  }

  private async guard(name: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.error(
        `toolset ${name} threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
