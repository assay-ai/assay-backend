import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SLA_WINDOW_SWEEP_CRON } from '../constants/sla-window.constants';
import { SlaWindowService } from '../services/sla-window.service';

/**
 * The cron wrapper around `SlaWindowService.sweepExpiredWindows`, and nothing
 * else.
 *
 * Modelled exactly on `PaymentIntentExpiryJob`: the sweep itself is a plain
 * service so it can be driven from a test — or, later, an operator endpoint —
 * with no scheduler in the picture, and a nonzero close count logged here is
 * the visible signal that a binding went quiet mid-window rather than closing
 * on its own traffic at the sample gate.
 *
 * A throw out of a `@Cron` handler is an unhandled rejection that takes the
 * scheduler process down with it, and the next pass would never run — the
 * same reasoning `PaymentIntentExpiryJob` and `StakeMonitorJob` give for the
 * try/catch below.
 */
@Injectable()
export class SlaWindowSweepJob {
  private readonly logger = new Logger(SlaWindowSweepJob.name);

  constructor(private readonly windows: SlaWindowService) {}

  @Cron(SLA_WINDOW_SWEEP_CRON)
  async handleSlaWindowSweep(): Promise<void> {
    try {
      const closed = await this.windows.sweepExpiredWindows();
      if (closed > 0) {
        this.logger.log(`SLA window age sweep closed ${closed} window(s) past their deadline.`);
      }
    } catch (error) {
      this.logger.error(
        `SLA window sweep pass aborted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
