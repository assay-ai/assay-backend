import { Module } from '@nestjs/common';

import { EnabledChainsModule } from '@modules/chains/enabled-chains.module';
import { ToolModule } from '@modules/tool/tool.module';

import { AgentServersController, McpUrlsController } from './controllers/mcp-urls.controller';
import { McpModule } from './mcp.module';
import { McpUrlPreviewService } from './services/mcp-url-preview.service';

/**
 * The REST routes about MCP URLs, on the API host: the Connect preview and
 * Servers in use. Separate from `McpHttpModule`, which serves the MCP host
 * itself and is mounted only by the MCP service.
 */
@Module({
  // `ToolModule` for the catalogue and the quote index the preview prices
  // from; `EnabledChainsModule` for the chains it quotes on.
  imports: [McpModule, ToolModule, EnabledChainsModule],
  controllers: [McpUrlsController, AgentServersController],
  providers: [McpUrlPreviewService],
})
export class McpUrlsApiModule {}
