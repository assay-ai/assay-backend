import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AgentIdParamDto } from '@modules/account/dto/agent-id-param.dto';
import { CurrentSession, HumanSessionGuard, SessionAuthGuard } from '@shared/auth';

import {
  McpUrlPreviewDto,
  PreviewMcpUrlBodyDto,
  RecordConnectUrlBodyDto,
  ServerInUseDto,
  ServersInUseDto,
} from '../dto/mcp-urls.dto';
import { McpSession } from '../ports/mcp-session.port';
import { McpUrlPreviewService } from '../services/mcp-url-preview.service';

/**
 * `POST /mcp-urls/preview` — what an MCP URL would serve an agent, for the
 * Connect sheet's summary line (design spec §7.9, §7.11). Parses only: the URL
 * is never fetched, and a URL of any other host is `URL_NOT_RECOGNISED`.
 */
@ApiTags('McpUrls')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard, HumanSessionGuard)
@Controller('mcp-urls')
export class McpUrlsController {
  constructor(private readonly previews: McpUrlPreviewService) {}

  @Post('preview')
  @HttpCode(200)
  @ApiOperation({
    summary: 'View ∩ access for an agent, with prices, a token estimate and warnings',
  })
  @ApiResponse({ status: 200, type: McpUrlPreviewDto })
  @ApiResponse({ status: 400, description: 'URL_NOT_RECOGNISED' })
  @ApiResponse({ status: 404, description: 'MCP_URL_NOT_FOUND, or ACCOUNT_AGENT_NOT_FOUND' })
  async preview(
    @CurrentSession() session: McpSession,
    @Body() body: PreviewMcpUrlBodyDto,
  ): Promise<McpUrlPreviewDto> {
    return this.previews.preview(session.organizationId, body.url, body.agentId);
  }
}

/** "Servers in use" and the URLs the Connect sheet hands out (§7.10, §7.11). */
@ApiTags('McpUrls')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard, HumanSessionGuard)
@Controller('agents/:agentId')
export class AgentServersController {
  constructor(private readonly previews: McpUrlPreviewService) {}

  @Get('servers')
  @ApiOperation({ summary: 'One row per MCP URL handed out or called through in 30 days' })
  @ApiResponse({ status: 200, type: ServersInUseDto })
  async servers(
    @CurrentSession() session: McpSession,
    @Param() params: AgentIdParamDto,
  ): Promise<ServersInUseDto> {
    return this.previews.serversInUse(session.organizationId, params.agentId);
  }

  @Post('connect-urls')
  @ApiOperation({ summary: 'Record a URL the Connect sheet handed out ("Waiting for first call")' })
  @ApiResponse({ status: 201, type: ServerInUseDto })
  @ApiResponse({ status: 400, description: 'URL_NOT_RECOGNISED' })
  async recordConnectUrl(
    @CurrentSession() session: McpSession,
    @Param() params: AgentIdParamDto,
    @Body() body: RecordConnectUrlBodyDto,
  ): Promise<ServerInUseDto> {
    return this.previews.recordConnectUrl(session.organizationId, params.agentId, body);
  }
}
