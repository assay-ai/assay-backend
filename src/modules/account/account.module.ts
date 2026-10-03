import { Module } from '@nestjs/common';

import { AgentCredentialsService } from './services/agent-credentials.service';
import { AgentsService } from './services/agents.service';
import { AuditLogService } from './services/audit-log.service';
import { NotificationsService } from './services/notifications.service';

/**
 * Account domain — notifications, the audit log, agents, and agent
 * credentials.
 *
 * The repositories these services use (`NotificationRepository`,
 * `AuditLogEntryRepository`, `AgentRepository`, `AgentCredentialRepository`,
 * plus `PaymentIntentRepository` / `VerificationRecordRepository` in the
 * sibling `payment` module for `tool-calls`) are provided globally by
 * `PostgresModule`, and `ConfigService` by the globally-registered
 * `ConfigModule`, so this module needs no `imports` for any of them — same
 * pattern as `PaymentModule`.
 */
@Module({
  providers: [NotificationsService, AuditLogService, AgentsService, AgentCredentialsService],
  exports: [NotificationsService, AuditLogService, AgentsService, AgentCredentialsService],
})
export class AccountModule {}
