import { Module } from '@nestjs/common';

import { McpModule } from '@modules/mcp/mcp.module';

import { CatalogueController } from './controllers/catalogue.controller';
import { CatalogueModule } from './catalogue.module';

/**
 * API-only half of the catalogue.
 *
 * `McpModule` is imported for `MCP_SESSION_SOURCE`, which `SessionAuthGuard`
 * injects. It is also why the controller cannot live in `CatalogueModule`:
 * `McpModule` imports `ToolModule`, so a guarded controller in a module that
 * `McpModule` could reach would ask the session source from a module the
 * session source's own module depends on — a cycle that fails to resolve in the
 * worker and the scheduler too, neither of which serves HTTP.
 * `FreeTierApiModule` and `ToolApiModule` record the same trap.
 */
@Module({
  imports: [CatalogueModule, McpModule],
  controllers: [CatalogueController],
})
export class CatalogueApiModule {}
