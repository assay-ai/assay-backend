import { Module } from '@nestjs/common';

import { BlocklistModule } from '@modules/blocklist/blocklist.module';
import { McpModule } from '@modules/mcp/mcp.module';
import { AuditLogModule } from '@shared/audit/audit-log.module';

import { AccountModule } from './account.module';
import { AccountBlockStatusController } from './controllers/account-block-status.controller';
import { AgentCredentialsController } from './controllers/agent-credentials.controller';
import { AgentDelegateController } from './controllers/agent-delegate.controller';
import { AgentsController } from './controllers/agents.controller';
import { AuditLogController } from './controllers/audit-log.controller';
import { NotificationsController } from './controllers/notifications.controller';
import { ReceiptPrivacyController } from './controllers/receipt-privacy.controller';
import { AccountBlockStatusService } from './services/account-block-status.service';
import { ReceiptPrivacyService } from './services/receipt-privacy.service';

/**
 * API-side account module — imported only by `AppApiModule`.
 *
 * `McpModule` is imported for one reason: it exports `MCP_SESSION_SOURCE`, the
 * DI token `SessionAuthGuard` resolves bearer tokens through — same pattern as
 * `ledger-api.module.ts`, `verification-api.module.ts`, `payment-api.module.ts`.
 */
@Module({
  imports: [AccountModule, McpModule, BlocklistModule, AuditLogModule],
  controllers: [
    NotificationsController,
    AuditLogController,
    AgentsController,
    AgentCredentialsController,
    AgentDelegateController,
    AccountBlockStatusController,
    ReceiptPrivacyController,
  ],
  providers: [AccountBlockStatusService, ReceiptPrivacyService],
  exports: [AccountModule],
})
export class AccountApiModule {}
