import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

/**
 * Used to run the finality sweep the moment the vault account moved, instead
 * of waiting for the next cron tick. **Disabled unconditionally since per-buyer
 * escrows.**
 *
 * ## Why it no longer does anything
 *
 * It was built around exactly one shared destination — the pooled Squads
 * vault's ATA — and `AccountWatchPort.watch` subscribes to exactly one
 * account. Per-buyer escrows move every deposit onto the buyer's own `["escrow",
 * buyer]` ATA, so there is no longer a single account whose movement means
 * "a deposit landed"; there are as many as there are buyers. Watching one of
 * them would accelerate that one buyer's deposits and nobody else's, which is
 * a worse and stranger behaviour than watching nothing, and there is no
 * single-account substitute to fall back to — the pooled vault stops
 * receiving deposits entirely.
 *
 * `DEPOSIT_FINALITY_SWEEP_CRON` (`EVERY_5_MINUTES`, wall-clock aligned) is
 * what actually guarantees a deposit is credited and is unaffected by this
 * class doing nothing: it was always the backfill for every notification that
 * never arrives, and now it is the only path. Turning this watcher off is
 * exactly what it was already safe to do at any time — see the class's
 * previous header, kept in history, for that argument in full.
 *
 * A per-buyer accelerator needs either `getProgramSubscribe` (watch the whole
 * program, filter client-side) or a fan-out of one subscription per open
 * escrow, and neither exists yet. It is worth building when sub-minute
 * deposit finality is needed.
 */
@Injectable()
export class DepositFinalityWatcher implements OnModuleInit {
  private readonly logger = new Logger(DepositFinalityWatcher.name);

  async onModuleInit(): Promise<void> {
    this.logger.log(
      'Deposit finality watcher is off (escrow deposits are per-buyer, a single-account ' +
        'watch no longer fits); deposits are credited by the finality sweep alone (every 5 seconds)',
    );
  }
}
