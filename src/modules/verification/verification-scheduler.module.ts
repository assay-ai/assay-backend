import { Module } from '@nestjs/common';

import { EvidenceRetentionJob } from './jobs/evidence-retention.job';
import { VerificationModule } from './verification.module';

/**
 * Scheduler-only half of the verification domain.
 *
 * `src/bootstrap/scheduler/app.module.ts` imports this and no other process
 * does, so the retention sweep runs once per deployment rather than once per
 * API replica — the same arrangement `PaymentSchedulerModule` and
 * `ProviderStakeMonitorSchedulerModule` use.
 */
@Module({
  imports: [VerificationModule],
  providers: [EvidenceRetentionJob],
})
export class VerificationSchedulerModule {}
