import { Module } from '@nestjs/common';

import { McpModule } from '@modules/mcp/mcp.module';
import { AuditLogModule } from '@shared/audit';

import { EscrowDelegatesController } from './controllers/escrow-delegates.controller';
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
  imports: [SettlementModule, McpModule, AuditLogModule],
  controllers: [EscrowController, EscrowDelegatesController],
  exports: [SettlementModule],
})
export class SettlementApiModule {}
