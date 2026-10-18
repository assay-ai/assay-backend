import { Module } from '@nestjs/common';

import { MCP_HOST_CONFIG, loadMcpHostConfig } from '@modules/toolset/config/mcp-host.config';

import { OAuthMetadataController } from './controllers/oauth-metadata.controller';
import { OAuthDiscoveryService } from './services/oauth-discovery.service';

/**
 * The OAuth routes on the MCP host. `AppMcpModule` imports it **before**
 * `McpHttpModule`, so its routes are matched before the MCP catch-all
 * (R-OA-29).
 *
 * Today: the discovery documents and the built-in client document. They need
 * only the public origins (`MCP_PUBLIC_URL`, `WEB_APP_URL`), read here with
 * the same loader the MCP controller uses, so this module holds no secret and
 * boots without the OAuth configuration.
 */
@Module({
  controllers: [OAuthMetadataController],
  providers: [
    { provide: MCP_HOST_CONFIG, useFactory: () => loadMcpHostConfig() },
    OAuthDiscoveryService,
  ],
})
export class OAuthMcpModule {}
