import { Module } from '@nestjs/common';

import { McpModule } from '@modules/mcp/mcp.module';

import { CatalogueController } from './controllers/catalogue.controller';
import { PublicCatalogueController } from './controllers/public-catalogue.controller';
import { PublicNotChargedController } from './controllers/public-not-charged.controller';
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
 *
 * The two public controllers (`/public/catalogue/*`, `/public/not-charged`)
 * take no guard and live here only because this is the catalogue's API half;
 * they are always registered.
 */
@Module({
  imports: [CatalogueModule, McpModule],
  controllers: [CatalogueController, PublicCatalogueController, PublicNotChargedController],
})
export class CatalogueApiModule {}
