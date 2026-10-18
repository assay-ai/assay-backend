import { Module } from '@nestjs/common';

import { DisputeModule } from './dispute.module';
import { CallDisputeRetentionJob } from './jobs/call-dispute-retention.job';
import { CallDisputeSlaJob } from './jobs/call-dispute-sla.job';
import { CallDisputeRetentionService } from './services/call-dispute-retention.service';
import { CallDisputeSlaService } from './services/call-dispute-sla.service';

/**
 * The scheduler's half of the dispute domain (G3.B1): the decision SLA
 * (provider silence, pages, auto-uphold, the chain timeout) and the snapshot
 * retention sweep. `DisputeModule` brings `CallDisputeService` and its config.
 */
@Module({
  imports: [DisputeModule],
  providers: [
    CallDisputeRetentionService,
    CallDisputeRetentionJob,
    CallDisputeSlaService,
    CallDisputeSlaJob,
  ],
})
export class DisputeSchedulerModule {}
