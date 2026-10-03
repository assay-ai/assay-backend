import { Module } from '@nestjs/common';

import { McpModule } from '@modules/mcp/mcp.module';

import { SpendPolicyController } from './controllers/spend-policy.controller';
import { SpendPolicyModule } from './spend-policy.module';

/**
 * API-side spend-policy module — imported only by `AppApiModule`.
 *
 * `McpModule` for `MCP_SESSION_SOURCE`, same reasoning as `LedgerApiModule`.
 */
@Module({
  imports: [SpendPolicyModule, McpModule],
  controllers: [SpendPolicyController],
  exports: [SpendPolicyModule],
})
export class SpendPolicyApiModule {}
