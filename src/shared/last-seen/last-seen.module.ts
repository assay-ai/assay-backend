import { Module } from '@nestjs/common';

import { LastSeenRecorder } from './last-seen.recorder';

/**
 * The "last seen" recorder, for every module that stamps or shows one.
 * Postgres and Redis come from the global modules.
 */
@Module({
  providers: [LastSeenRecorder],
  exports: [LastSeenRecorder],
})
export class LastSeenModule {}
