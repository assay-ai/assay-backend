import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { HeldCollectionService } from '../services/held-collection.service';

/**
 * Every minute, at second 30 — the redemption job runs at second 0 on the same
 * redeemer key — collect held payments past their dispute window (G3.B1), and
 * refund those of a blocked provider.
 */
@Injectable()
export class HeldCollectionJob {
  private readonly logger = new Logger(HeldCollectionJob.name);

  constructor(private readonly collection: HeldCollectionService) {}

  @Cron('30 * * * * *', { waitForCompletion: true })
  async handleHeldCollection(): Promise<void> {
    try {
      await this.collection.run();
    } catch (error) {
      this.logger.error(
        `Held collection threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
