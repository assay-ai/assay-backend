import { Module } from '@nestjs/common';
import { SchedulePostsModule } from './schedule/schedule.module';

/**
 * Scheduler-side grouping of the starter's reference modules — see
 * `./README.md`.
 *
 * Imported by `AppSchedulerModule` behind `areExamplesEnabled()`. The scheduler
 * runs as a single instance, so a sample `@Cron` left enabled by accident fires
 * on a real schedule — another reason the group defaults to off in production.
 */
@Module({
  imports: [SchedulePostsModule],
})
export class ExamplesSchedulerModule {}
