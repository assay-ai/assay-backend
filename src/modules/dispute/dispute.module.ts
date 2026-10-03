import { Module } from '@nestjs/common';

import { DisputeService } from './services/dispute.service';

/**
 * Dispute domain — challenges to a verdict, an SLA window, or a payment
 * intent. A provider disputing a call it served and an agent disputing its own
 * call are the two directions one table serves; see `DisputeEntity`'s class
 * comment for why it is one table rather than two.
 *
 * `DisputeService` reads `disputes`, `payment_intents` and
 * `verification_records` directly through the repositories `PostgresModule`
 * provides globally, so this module declares no imports of its own.
 *
 * Scope: opening, acknowledging, withdrawing and reading. Adjudication — who
 * reviews, on what SLA, how a partial overturn restores stake — is not
 * implemented here; `resolvedAt` / `resolvedBy` / `resolutionNote` /
 * `restoredAmount` are columns nothing here writes.
 */
@Module({
  providers: [DisputeService],
  exports: [DisputeService],
})
export class DisputeModule {}
