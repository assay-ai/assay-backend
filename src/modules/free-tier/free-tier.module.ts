import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { NotificationModule } from '@modules/notification/notification.module';

import { FREE_QUOTA_CONFIG, freeQuotaConfigFactory } from './config/free-quota.config';
import { FreeQuotaService } from './services/free-quota.service';
import { ToolCallRecordWriter } from './services/tool-call-record-writer.service';

/**
 * The free tier — quota accounting, the record a free call leaves behind, and
 * `GET /free-quota`.
 *
 * ```text
 * FreeQuotaService          check() / consume() — the four independent limits
 * ToolCallRecordWriter      writes tool_call_records for a completed relay call
 * FreeQuotaController       GET /free-quota
 * ```
 *
 * **What this module does not do.** The relay branch itself — the decision
 * inside `tools/call` to skip the payment machinery — lives in
 * `McpToolCallService`, which is wired directly rather than through this
 * module, because it is the one class that decides whether money moves. This
 * module supplies the two services that branch calls into and nothing that
 * calls back into it.
 */
@Module({
  // `NOTIFICATION_PORT`, for `free_quota.exhausted`. See the note in
  // `SpendPolicyModule` on why this is an explicit import and not a global.
  imports: [ConfigModule, NotificationModule],
  providers: [
    {
      provide: FREE_QUOTA_CONFIG,
      useFactory: freeQuotaConfigFactory,
      inject: [ConfigService],
    },
    FreeQuotaService,
    ToolCallRecordWriter,
  ],
  exports: [FreeQuotaService, ToolCallRecordWriter, FREE_QUOTA_CONFIG],
})
export class FreeTierModule {}
