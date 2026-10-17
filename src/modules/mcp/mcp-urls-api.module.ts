import { Module } from '@nestjs/common';

import { AgentServersController, McpUrlsController } from './controllers/mcp-urls.controller';
import { McpModule } from './mcp.module';
import { McpUrlPreviewService } from './services/mcp-url-preview.service';

/**
 * The REST routes about MCP URLs, on the API host: the Connect preview and
 * Servers in use. Separate from `McpHttpModule`, which serves the MCP host
 * itself and is mounted only by the MCP service.
 */
@Module({
  imports: [McpModule],
  controllers: [McpUrlsController, AgentServersController],
  providers: [McpUrlPreviewService],
})
export class McpUrlsApiModule {}
