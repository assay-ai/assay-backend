import { Module } from '@nestjs/common';

import { ToolsetSharingJobs } from './jobs/toolset-sharing.jobs';
import { ToolsetModule } from './toolset.module';

/**
 * Scheduler-only half of toolsets: grace and cutoff sweeps, daily and weekly
 * stats. Registered only in `AppSchedulerModule`.
 */
@Module({
  imports: [ToolsetModule],
  providers: [ToolsetSharingJobs],
})
export class ToolsetSchedulerModule {}
