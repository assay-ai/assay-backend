import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { LastSeenFlusher } from './last-seen.flusher';

/** Every 30 seconds. */
export const LAST_SEEN_FLUSH_CRON = '5,35 * * * * *';

/** The cron wrapper around {@link LastSeenFlusher.flush}. Scheduler only. */
@Injectable()
export class LastSeenFlushJob {
  private readonly logger = new Logger(LastSeenFlushJob.name);

  constructor(private readonly flusher: LastSeenFlusher) {}

  @Cron(LAST_SEEN_FLUSH_CRON, { waitForCompletion: true })
  async handleFlush(): Promise<void> {
    try {
      const summary = await this.flusher.flush();
      if (summary.skipped) return;
      const written = Object.entries(summary.written).filter(([, count]) => (count ?? 0) > 0);
      if (written.length > 0) {
        this.logger.debug(
          `last-seen flushed: ${written.map(([kind, count]) => `${kind}=${count}`).join(' ')}`,
        );
      }
    } catch (error) {
      // A throw out of a @Cron handler would be an unhandled rejection.
      this.logger.error(
        `last-seen flush failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
