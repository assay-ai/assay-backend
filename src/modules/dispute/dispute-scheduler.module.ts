import { Module } from '@nestjs/common';

import { CALL_DISPUTE_CONFIG, loadCallDisputeConfig } from './constants/call-dispute.config';
import { CallDisputeRetentionJob } from './jobs/call-dispute-retention.job';
import { CallDisputeRetentionService } from './services/call-dispute-retention.service';

/**
 * The scheduler's half of the dispute domain: the call-dispute snapshot
 * retention sweep. Needs only the global `DataSource`, so it does not pull in
 * `DisputeModule`'s payment and verification graph.
 */
@Module({
  providers: [
    CallDisputeRetentionService,
    CallDisputeRetentionJob,
    { provide: CALL_DISPUTE_CONFIG, useFactory: () => loadCallDisputeConfig() },
  ],
})
export class DisputeSchedulerModule {}
