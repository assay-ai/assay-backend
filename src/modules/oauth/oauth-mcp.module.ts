import { Global, Module } from '@nestjs/common';

import {
  MCP_UNAUTHORIZED_RECORDER,
  McpUnauthorizedRecorder,
} from '@modules/mcp/ports/mcp-unauthorized.port';

import { OAuthAuthorizeController } from './controllers/oauth-authorize.controller';
import { OAuthRegisterController } from './controllers/oauth-register.controller';
import { OAuthRevokeController } from './controllers/oauth-revoke.controller';
import { OAuthTokenController } from './controllers/oauth-token.controller';
import { OAuthCoreModule } from './oauth-core.module';
import { OAuthDiscoveryModule } from './oauth-discovery.module';
import { OAuthMetrics } from './services/oauth-metrics.service';
import { OAuthRequestStore } from './services/oauth-request.store';

/**
 * The OAuth routes on the MCP host. `AppMcpModule` imports it **before**
 * `McpHttpModule`, so its routes are matched before the MCP catch-all
 * (R-OA-29).
 *
 * ```text
 * discovery    /.well-known/*, /oauth/clients/assay-mcp   OAuthDiscoveryModule
 * authorize    GET /oauth/authorize, …/continue           OAuthAuthorizeController
 * token        POST /oauth/token                          OAuthTokenController
 * register     POST /oauth/register                       OAuthRegisterController
 * revoke       POST /oauth/revoke                         OAuthRevokeController
 * ```
 *
 * `OAuthCoreModule` brings the configuration (under `APP_ROLE = 'mcp'` it
 * requires `OAUTH_REQUEST_COOKIE_SECRET`), the registry, the token service,
 * the limiter and the metrics; its `NotificationModule` needs the app's
 * BullMQ root, which `AppMcpModule` has. `OAuthRequestStore` is the same
 * class the API app's consent API uses, over the same Redis keys.
 *
 * `@Global()` for one export only: `MCP_UNAUTHORIZED_RECORDER`, which the MCP
 * catch-all (`McpHttpModule`, a sibling) uses to count its 401s by reason
 * (`assay_mcp_unauthorized_total`, §6.7) on this container's `OAuthMetrics`.
 * The API app and the scheduler never import this module, so they have no
 * recorder and no OAuth metrics.
 */
@Global()
@Module({
  imports: [OAuthDiscoveryModule, OAuthCoreModule],
  controllers: [
    OAuthAuthorizeController,
    OAuthTokenController,
    OAuthRegisterController,
    OAuthRevokeController,
  ],
  providers: [
    OAuthRequestStore,
    {
      provide: MCP_UNAUTHORIZED_RECORDER,
      useFactory: (metrics: OAuthMetrics): McpUnauthorizedRecorder => ({
        record: (reason) => metrics.incMcpUnauthorized(reason),
      }),
      inject: [OAuthMetrics],
    },
  ],
  exports: [MCP_UNAUTHORIZED_RECORDER],
})
export class OAuthMcpModule {}
