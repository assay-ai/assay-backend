import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { STAKE_MONITOR_CRON } from '../constants/stake-monitor.constants';
import { StakeMonitorService } from '../services/stake-monitor.service';

/**
 * The cron wrapper around `StakeMonitorService.sweep`.
 *
 * Same shape as `ReconciliationJob` and `ProviderPayoutBatchJob`, on purpose —
 * registered only in `ProviderStakeMonitorSchedulerModule`, which only the
 * scheduler process imports. The scheduler is a single instance by design
 * (`docs/architecture.md` §Scaling Design), so this fires once per deployment
 * rather than once per API replica. That matters more here than for the other
 * two: N replicas racing the same pass would each try to open the same grace
 * row, and the partial unique index would let one win and N−1 waste a write.
 *
 * The handler cannot throw. `sweep()` isolates every provider internally, and
 * the catch below covers anything left — a cron handler that rejects is logged
 * by Nest and then forgotten, which is precisely the failure mode that would
 * make the seven-day grace period quietly untrue.
 */
@Injectable()
export class StakeMonitorJob {
  private readonly logger = new Logger(StakeMonitorJob.name);

  constructor(private readonly monitor: StakeMonitorService) {}

  @Cron(STAKE_MONITOR_CRON)
  async handleStakeMonitor(): Promise<void> {
    try {
      await this.monitor.sweep();
    } catch (error) {
      this.logger.error(
        `Stake monitor threw past its own error handling: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
