import { Module } from '@nestjs/common';

import { MCP_HOST_CONFIG, loadMcpHostConfig } from '@modules/toolset/config/mcp-host.config';

import { OAuthMetadataController } from './controllers/oauth-metadata.controller';
import { OAuthDiscoveryService } from './services/oauth-discovery.service';

/**
 * The discovery documents and the built-in client document on the MCP host
 * (spec §6.3.1, §6.3.2, §6.3.6 item 3). They need only the public origins
 * (`MCP_PUBLIC_URL`, `WEB_APP_URL`), read with the same loader the MCP
 * controller uses, so this module holds no secret and needs no database.
 * Imported by `OAuthMcpModule`.
 */
@Module({
  controllers: [OAuthMetadataController],
  providers: [
    { provide: MCP_HOST_CONFIG, useFactory: () => loadMcpHostConfig() },
    OAuthDiscoveryService,
  ],
})
export class OAuthDiscoveryModule {}
