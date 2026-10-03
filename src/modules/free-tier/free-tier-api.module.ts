import { Module } from '@nestjs/common';

import { McpModule } from '@modules/mcp/mcp.module';

import { FreeQuotaController } from './controllers/free-quota.controller';
import { FreeTierModule } from './free-tier.module';

/**
 * API-side free-tier module — imported only by `AppApiModule`.
 *
 * `GET /free-quota` lives here rather than in `FreeTierModule` for the reason
 * every other `*-api.module.ts` exists: the controller is behind
 * `SessionAuthGuard`, which needs `MCP_SESSION_SOURCE`, and `McpModule`
 * imports `FreeTierModule` for the relay path. A controller inside
 * `FreeTierModule` would therefore demand the session source from a module the
 * session source's own module depends on — which fails to resolve in every
 * process, including the two that never serve HTTP.
 */
@Module({
  imports: [FreeTierModule, McpModule],
  controllers: [FreeQuotaController],
  exports: [FreeTierModule],
})
export class FreeTierApiModule {}
