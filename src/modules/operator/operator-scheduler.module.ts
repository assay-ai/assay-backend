import { Module } from '@nestjs/common';

import { OperatorApprovalExpiryJob } from './jobs/operator-approval-expiry.job';

/**
 * Scheduler-only half of the operator module: the approvals expiry sweep.
 * Registered only in `AppSchedulerModule`. `OperatorApprovalRepository` comes
 * from the global Postgres module.
 */
@Module({
  providers: [OperatorApprovalExpiryJob],
})
export class OperatorSchedulerModule {}
