import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { auditActorOf } from '@shared/audit';
import { CurrentSession, HumanSessionGuard, SessionAuthGuard } from '@shared/auth';

import {
  CreateToolsetBodyDto,
  ListToolsetsQueryDto,
  ReplaceToolsetEntriesBodyDto,
  ToolsetDto,
  ToolsetIdParamDto,
  ToolsetSummaryDto,
  UpdateToolsetBodyDto,
} from '../dto/toolset.dto';
import { ToolsetsService } from '../services/toolsets.service';

/**
 * `/toolsets` — the organization's own tool sets and their Draft (design
 * spec §7.9, the T1 subset). A tool set of another organization is a 404.
 * Writes are a person's: an agent's credential may read the sets its
 * organization owns, never change what it can be routed through.
 */
@ApiTags('Toolsets')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('toolsets')
export class ToolsetsController {
  constructor(private readonly toolsets: ToolsetsService) {}

  @Get()
  @ApiOperation({ summary: "The organization's tool sets, newest first" })
  @ApiCursorPage(ToolsetSummaryDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListToolsetsQueryDto,
  ): Promise<CursorPageDto<ToolsetSummaryDto>> {
    return this.toolsets.list(session.organizationId, query);
  }

  @Post()
  @UseGuards(HumanSessionGuard)
  @ApiOperation({ summary: 'Create a tool set (PRIVATE); its Draft is served at /my/{slug}' })
  @ApiResponse({ status: 201, type: ToolsetDto })
  @ApiResponse({ status: 409, description: 'TOOLSET_SLUG_TAKEN, with a free `suggestion`' })
  @ApiResponse({ status: 429, description: 'TOOLSET_LIMIT_EXCEEDED (100 per organization)' })
  async create(
    @CurrentSession() session: McpSession,
    @Body() body: CreateToolsetBodyDto,
  ): Promise<ToolsetDto> {
    return this.toolsets.create(session.organizationId, body, auditActorOf(session));
  }

  @Get(':id')
  @ApiOperation({ summary: 'One tool set with its Draft entries' })
  @ApiResponse({ status: 200, type: ToolsetDto })
  @ApiResponse({ status: 404, description: 'TOOLSET_NOT_FOUND — also for another organization' })
  async get(
    @CurrentSession() session: McpSession,
    @Param() params: ToolsetIdParamDto,
  ): Promise<ToolsetDto> {
    return this.toolsets.get(session.organizationId, params.id);
  }

  @Patch(':id')
  @UseGuards(HumanSessionGuard)
  @ApiOperation({ summary: 'Edit name, slug, description, category, tags, icon, discovery, pins' })
  @ApiResponse({ status: 200, type: ToolsetDto })
  async update(
    @CurrentSession() session: McpSession,
    @Param() params: ToolsetIdParamDto,
    @Body() body: UpdateToolsetBodyDto,
  ): Promise<ToolsetDto> {
    return this.toolsets.update(session.organizationId, params.id, body, auditActorOf(session));
  }

  @Put(':id/entries')
  @UseGuards(HumanSessionGuard)
  @ApiOperation({
    summary: 'Replace the Draft entries — changes reach connected agents immediately',
  })
  @ApiResponse({ status: 200, type: ToolsetDto })
  @ApiResponse({ status: 429, description: 'TOOLSET_LIMIT_EXCEEDED (200 entries)' })
  async replaceEntries(
    @CurrentSession() session: McpSession,
    @Param() params: ToolsetIdParamDto,
    @Body() body: ReplaceToolsetEntriesBodyDto,
  ): Promise<ToolsetDto> {
    return this.toolsets.replaceEntries(
      session.organizationId,
      params.id,
      body.entries,
      auditActorOf(session),
    );
  }

  @Delete(':id')
  @UseGuards(HumanSessionGuard)
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a tool set; its URL stops serving at once' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  async delete(
    @CurrentSession() session: McpSession,
    @Param() params: ToolsetIdParamDto,
  ): Promise<void> {
    await this.toolsets.delete(session.organizationId, params.id, auditActorOf(session));
  }
}
