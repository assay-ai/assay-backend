import { Module } from '@nestjs/common';

import { McpModule } from '@modules/mcp/mcp.module';

import { ToolsController } from './controllers/tools.controller';
import { PublicToolCatalogueService } from './services/public-tool-catalogue.service';
import { ToolModule } from './tool.module';

/**
 * API-only half of the tool domain.
 *
 * `ToolModule` is the shared half — the router, the invoker, the catalogue
 * ports — and it is imported by the worker too. The controller lives here so
 * that adding a buyer route does not put an HTTP surface into the worker
 * process, which is the same split every other domain in this codebase uses.
 *
 * `TOOL_CATALOGUE` resolves out of `ToolModule`, which exports it.
 *
 * `McpModule` is imported for `MCP_SESSION_SOURCE`, which `SessionAuthGuard`
 * injects — the same line every other `*-api.module.ts` carrying a guarded
 * controller has. It is also the reason the controller cannot live in
 * `ToolModule` itself: `McpModule` imports `ToolModule` (the MCP loop routes
 * through it), so a guarded controller in there would ask the session source
 * from a module that the session source's own module depends on, and the cycle
 * fails to resolve in every process — including the worker and the scheduler,
 * which never serve HTTP at all. `FreeTierApiModule` records the same trap.
 */
@Module({
  imports: [ToolModule, McpModule],
  controllers: [ToolsController],
  providers: [PublicToolCatalogueService],
})
export class ToolApiModule {}
