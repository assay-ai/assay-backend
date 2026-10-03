import { Module } from '@nestjs/common';

import { McpModule } from '@modules/mcp/mcp.module';

import { EscrowController } from './controllers/escrow.controller';
import { SettlementModule } from './settlement.module';

/**
 * API-side settlement module — imported only by `AppApiModule`.
 *
 * `EscrowController`, the settlement domain's first HTTP surface —
 * `GET /escrow` plus the four buyer-signed intent builders. Same shape as
 * `payment-api.module.ts` / `ledger-api.module.ts`: `McpModule` is imported
 * for exactly one reason, `MCP_SESSION_SOURCE`, the DI token
 * `SessionAuthGuard` resolves bearer tokens through — even though this
 * controller's actual caller is the console, not an agent, the guard is the
 * same one every session-scoped route uses.
 */
@Module({
  imports: [SettlementModule, McpModule],
  controllers: [EscrowController],
  exports: [SettlementModule],
})
export class SettlementApiModule {}
