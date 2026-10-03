import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { FREE_QUOTA_CONFIG, freeQuotaConfigFactory } from './config/free-quota.config';
import { ToolCallRecordRetentionJob } from './jobs/tool-call-record-retention.job';
import { ToolCallRecordRetentionService } from './services/tool-call-record-retention.service';

/**
 * Scheduler-only half of the free-tier domain.
 *
 * `src/bootstrap/scheduler/app.module.ts` imports this and no other process
 * does, so the retention sweep runs once per deployment rather than once per
 * API replica — the same arrangement `VerificationSchedulerModule` uses.
 *
 * Its own `FREE_QUOTA_CONFIG` binding rather than importing `FreeTierModule`:
 * that module also mounts `FreeQuotaController` and provides `FreeQuotaService`
 * (which needs `NOTIFICATION_PORT` — see `FreeTierModule`'s own doc comment),
 * neither of which the scheduler process has any use for or any way to
 * satisfy. Duplicating the three-line config binding here is cheaper than
 * making the scheduler process carry a dependency it does not need.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: FREE_QUOTA_CONFIG,
      useFactory: freeQuotaConfigFactory,
      inject: [ConfigService],
    },
    ToolCallRecordRetentionService,
    ToolCallRecordRetentionJob,
  ],
})
export class FreeTierSchedulerModule {}
