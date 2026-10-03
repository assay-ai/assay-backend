import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import {
  DEPOSIT_FINALITY_SWEEP_BATCH,
  DEPOSIT_FINALITY_SWEEP_CRON,
} from '../constants/deposit-intent.constants';
import { DepositFinalityService } from '../services/deposit-finality.service';

/** The cron wrapper around `DepositFinalityService.promotePendingDeposits`. */
@Injectable()
export class DepositFinalityJob {
  private readonly logger = new Logger(DepositFinalityJob.name);

  constructor(private readonly finality: DepositFinalityService) {}

  @Cron(DEPOSIT_FINALITY_SWEEP_CRON)
  async handleFinalitySweep(): Promise<void> {
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
