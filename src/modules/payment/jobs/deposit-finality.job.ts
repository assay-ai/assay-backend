import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import {
  DEPOSIT_FINALITY_SWEEP_BATCH,
  DEPOSIT_FINALITY_SWEEP_CRON,
} from '../constants/deposit-intent.constants';
import { DepositFinalityService } from '../services/deposit-finality.service';
import { DepositService } from '../services/deposit.service';

/**
 * The cron wrapper around `DepositFinalityService.promotePendingDeposits`,
 * and around `DepositService.resumeStuckSettling` on the same cadence: a
 * `SETTLING` intent whose request died (a failed chain read after the
 * facilitator settled, a crash before `SETTLED`) is retried here, never left.
 */
@Injectable()
export class DepositFinalityJob {
  private readonly logger = new Logger(DepositFinalityJob.name);

  constructor(
    private readonly finality: DepositFinalityService,
    private readonly deposits: DepositService,
  ) {}

  @Cron(DEPOSIT_FINALITY_SWEEP_CRON)
  async handleFinalitySweep(): Promise<void> {
    try {
      const resumed = await this.deposits.resumeStuckSettling(DEPOSIT_FINALITY_SWEEP_BATCH);
      if (resumed.resolved) {
        this.logger.log(
          `Deposit SETTLING resume: ${resumed.checked} stuck, ${resumed.resolved} resolved`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Deposit SETTLING resume aborted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const report = await this.finality.promotePendingDeposits(DEPOSIT_FINALITY_SWEEP_BATCH);
      if (report.confirmed || report.rejected) {
        this.logger.log(
          `Deposit finality sweep: ${report.checked} checked, ${report.confirmed} confirmed, ` +
            `${report.rejected} rejected, ${report.skipped} skipped`,
        );
      } else if (report.checked) {
        // Waiting is now a real outcome — a transfer that is mined but not
        // final yet stays queued (see `DepositFinalityService`). Silent
        // otherwise: on a chain whose finality trails by ~17 minutes that is
        // three passes where the log would say nothing happened, and a deposit
        // nobody can see waiting is one nobody can tell from a deposit nobody
        // is working on.
        this.logger.log(
          `Deposit finality sweep: ${report.checked} checked, none resolved yet ` +
            `(${report.skipped} still waiting for finality)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Deposit finality sweep pass aborted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
