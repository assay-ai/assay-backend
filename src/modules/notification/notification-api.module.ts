import { Module } from '@nestjs/common';

import { AuditLogModule } from '@shared/audit';
import { McpModule } from '@modules/mcp/mcp.module';

import { NotificationSettingsController } from './controllers/notification-settings.controller';
import { NotificationSettingsService } from './services/notification-settings.service';

/**
 * API-side notification module — imported only by `AppApiModule`.
 *
 * `McpModule` is imported for `MCP_SESSION_SOURCE`, the DI token
 * `SessionAuthGuard` resolves bearer tokens through — same pattern as
 * `account-api.module.ts`, `ledger-api.module.ts`, `verification-api.module.ts`.
 * The repositories (`NotificationChannelRepository`,
 * `NotificationPreferenceRepository`, `NotificationRepository`,
 * `NotificationDeliveryRepository`) need no import — `PostgresModule`
 * provides them globally.
 */
@Module({
  imports: [McpModule, AuditLogModule],
  controllers: [NotificationSettingsController],
  providers: [NotificationSettingsService],
  exports: [NotificationSettingsService],
})
export class NotificationApiModule {}
