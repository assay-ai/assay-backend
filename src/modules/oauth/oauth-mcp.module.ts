import { Module } from '@nestjs/common';

import { OAuthAuthorizeController } from './controllers/oauth-authorize.controller';
import { OAuthRegisterController } from './controllers/oauth-register.controller';
import { OAuthRevokeController } from './controllers/oauth-revoke.controller';
import { OAuthTokenController } from './controllers/oauth-token.controller';
import { OAuthCoreModule } from './oauth-core.module';
import { OAuthDiscoveryModule } from './oauth-discovery.module';
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
 */
@Module({
  imports: [OAuthDiscoveryModule, OAuthCoreModule],
  controllers: [
    OAuthAuthorizeController,
    OAuthTokenController,
    OAuthRegisterController,
    OAuthRevokeController,
  ],
  providers: [OAuthRequestStore],
})
export class OAuthMcpModule {}
