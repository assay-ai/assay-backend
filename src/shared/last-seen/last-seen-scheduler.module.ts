import { Module } from '@nestjs/common';

import { LastSeenFlushJob } from './last-seen-flush.job';
import { LastSeenFlusher } from './last-seen.flusher';

/**
 * Scheduler-only: writes the buffered "last seen" stamps every 30 s.
 * Registered only in `AppSchedulerModule`.
 */
@Module({
  providers: [LastSeenFlusher, LastSeenFlushJob],
})
export class LastSeenSchedulerModule {}
