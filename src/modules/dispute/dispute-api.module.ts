import { Module } from '@nestjs/common';

import { McpModule } from '@modules/mcp/mcp.module';

import { CallDisputesController } from './controllers/call-disputes.controller';
import { ProviderCallDisputesController } from './controllers/provider-call-disputes.controller';
import { DisputeModule } from './dispute.module';

/**
 * API-side dispute module — imported only by `AppApiModule`.
 *
 * Imports `McpModule` for one reason: it exports `MCP_SESSION_SOURCE`, the DI
 * token `SessionAuthGuard` resolves bearer tokens through
 * (`shared/auth/session-auth.guard.ts`).
 */
@Module({
  imports: [DisputeModule, McpModule],
  controllers: [CallDisputesController, ProviderCallDisputesController],
  exports: [DisputeModule],
})
export class DisputeApiModule {}
