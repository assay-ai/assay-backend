import { Module } from '@nestjs/common';

import { McpController } from './controllers/mcp.controller';
import { McpModule } from './mcp.module';
import { McpAuthFailureThrottle } from './services/mcp-auth-failure-throttle.service';

/**
 * The MCP transport, mounted.
 *
 * Separate from {@link McpModule} for the same reason `*-api.module.ts` is
 * separate everywhere else in this codebase: importing a domain must not
 * silently open a route. `AppApiModule` imports `McpModule` so the REST surface
 * can price and describe tools; only the `mcp` service imports this one, and
 * only that service serves the MCP host's paths (`/`, `/my/{slug}`, …).
 *
 * `mcp` is its own scaling unit, which is what `src/bootstrap/mcp/` makes real.
 */
@Module({
  imports: [McpModule],
  controllers: [McpController],
  providers: [McpAuthFailureThrottle],
})
export class McpHttpModule {}
