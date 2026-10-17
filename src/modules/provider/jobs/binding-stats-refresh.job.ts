import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { BINDING_STATS_REFRESH_CRON } from '../constants/binding-stats.constants';
import { BindingStatsService } from '../services/binding-stats.service';

/**
 * The cron wrapper around `BindingStatsService.refresh`, and nothing else.
 *
 * Same shape as `SlaWindowSweepJob`: the handler cannot throw, because a
 * rejected `@Cron` handler is logged once and the stats would then silently
 * stop moving — every provider frozen on its last snapshot, which looks
 * exactly like a healthy, quiet platform.
 */
@Injectable()
export class BindingStatsRefreshJob {
  private readonly logger = new Logger(BindingStatsRefreshJob.name);

  constructor(private readonly stats: BindingStatsService) {}

  @Cron(BINDING_STATS_REFRESH_CRON, { waitForCompletion: true })
  async handleBindingStatsRefresh(): Promise<void> {
    try {
      await this.stats.refresh();
    } catch (error) {
      this.logger.error(
        `Binding stats refresh aborted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
