import { Module } from '@nestjs/common';

import { OperatorModule } from '@modules/operator/operator.module';

import { DisputeModule } from './dispute.module';
import { CallDisputeRefundJob } from './jobs/call-dispute-refund.job';
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
  // `OperatorModule` for `OverrideLogService`: the auto-uphold is logged as S-14.
  imports: [DisputeModule, OperatorModule],
  providers: [
    CallDisputeRetentionService,
    CallDisputeRetentionJob,
    CallDisputeSlaService,
    CallDisputeSlaJob,
    // The redeemer key is the scheduler's: upheld refunds are sent here.
    CallDisputeRefundJob,
  ],
})
export class DisputeSchedulerModule {}
