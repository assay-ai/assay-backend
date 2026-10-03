import { Module } from '@nestjs/common';

import { McpModule } from '@modules/mcp/mcp.module';

import { AccountModule } from './account.module';
import { AgentCredentialsController } from './controllers/agent-credentials.controller';
import { AgentsController } from './controllers/agents.controller';
import { AuditLogController } from './controllers/audit-log.controller';
import { NotificationsController } from './controllers/notifications.controller';

/**
 * API-side account module — imported only by `AppApiModule`.
 *
 * `McpModule` is imported for one reason: it exports `MCP_SESSION_SOURCE`, the
 * DI token `SessionAuthGuard` resolves bearer tokens through — same pattern as
 * `ledger-api.module.ts`, `verification-api.module.ts`, `payment-api.module.ts`.
 */
@Module({
  imports: [AccountModule, McpModule],
  controllers: [
    NotificationsController,
    AuditLogController,
    AgentsController,
    AgentCredentialsController,
  ],
  exports: [AccountModule],
})
export class AccountApiModule {}
