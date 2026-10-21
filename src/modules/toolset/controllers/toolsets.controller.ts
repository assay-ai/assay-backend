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
import {
  CopyResultDto,
  CopyToolsetBodyDto,
  PublishResultDto,
  PublishToolsetBodyDto,
  ToolsetOwnStatsDto,
  ToolsetVersionDto,
  ToolsetVersionParamDto,
  ToolsetVersionSummaryDto,
} from '../dto/toolset-publishing.dto';
import { ToolsetPublishingService } from '../services/toolset-publishing.service';
import { ToolsetsService } from '../services/toolsets.service';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

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
  constructor(
    private readonly toolsets: ToolsetsService,
    private readonly publishing: ToolsetPublishingService,
  ) {}

  @Get()
  @TenantCache({ ttl: 30, vary: 'org', epochs: ['toolsets', 'shared'] })
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
  @TenantCache({ ttl: 30, vary: 'org', epochs: ['toolsets', 'shared'] })
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
  @ApiOperation({
    summary:
      'Delete a tool set. Its shared URLs keep serving the last version for 90 days when other ' +
      'organizations use it; otherwise every URL stops at once',
  })
  @ApiResponse({ status: 204, description: 'Deleted' })
  async delete(
    @CurrentSession() session: McpSession,
    @Param() params: ToolsetIdParamDto,
  ): Promise<void> {
    await this.toolsets.delete(session.organizationId, params.id, auditActorOf(session));
  }

  @Post(':id/publish')
  @UseGuards(HumanSessionGuard)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Share dialog: publish the next version and set the visibility in one step',
    description:
      'Snapshots the Draft and its settings as vN (immutable). UNLISTED creates a link; PUBLIC ' +
      'lists it (only LISTED tools allowed). Both need a public name and lock it. At most 10 ' +
      'versions per tool set per UTC day.',
  })
  @ApiResponse({ status: 200, type: PublishResultDto })
  @ApiResponse({ status: 400, description: 'TOOLSET_NOT_PUBLISHABLE, with `toolIds`' })
  @ApiResponse({ status: 409, description: 'TOOLSET_HANDLE_REQUIRED, TOOLSET_SHARING_REFUSED' })
  @ApiResponse({ status: 429, description: 'TOOLSET_LIMIT_EXCEEDED (versionsPerToolsetPerDay)' })
  async publish(
    @CurrentSession() session: McpSession,
    @Param() params: ToolsetIdParamDto,
    @Body() body: PublishToolsetBodyDto,
  ): Promise<PublishResultDto> {
    return this.publishing.publish(session.organizationId, params.id, body, auditActorOf(session));
  }

  @Post(':id/unpublish')
  @UseGuards(HumanSessionGuard)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Stop sharing: PRIVATE; old shared URLs serve the last version for 90 days',
  })
  @ApiResponse({ status: 200, type: PublishResultDto })
  async unpublish(
    @CurrentSession() session: McpSession,
    @Param() params: ToolsetIdParamDto,
  ): Promise<PublishResultDto> {
    return this.publishing.unpublish(session.organizationId, params.id, auditActorOf(session));
  }

  @Post(':id/unlisted-token/rotate')
  @UseGuards(HumanSessionGuard)
  @HttpCode(200)
  @ApiOperation({ summary: 'A new link; the old one stops working at once' })
  @ApiResponse({ status: 200, type: PublishResultDto })
  @ApiResponse({ status: 409, description: 'TOOLSET_SHARING_REFUSED (NOT_SHARED)' })
  async rotate(
    @CurrentSession() session: McpSession,
    @Param() params: ToolsetIdParamDto,
  ): Promise<PublishResultDto> {
    return this.publishing.rotateToken(session.organizationId, params.id, auditActorOf(session));
  }

  @Get(':id/versions')
  @TenantCache({ ttl: 30, vary: 'org', epochs: ['toolsets', 'shared'] })
  @ApiOperation({ summary: 'Published versions, newest first' })
  @ApiResponse({ status: 200, type: [ToolsetVersionSummaryDto] })
  async versions(
    @CurrentSession() session: McpSession,
    @Param() params: ToolsetIdParamDto,
  ): Promise<ToolsetVersionSummaryDto[]> {
    return this.publishing.listVersions(session.organizationId, params.id);
  }

  @Get(':id/versions/:version')
  @TenantCache({ ttl: 30, vary: 'org', epochs: ['toolsets', 'shared'] })
  @ApiOperation({ summary: 'One published version: its snapshot' })
  @ApiResponse({ status: 200, type: ToolsetVersionDto })
  async version(
    @CurrentSession() session: McpSession,
    @Param() params: ToolsetVersionParamDto,
  ): Promise<ToolsetVersionDto> {
    return this.publishing.getVersion(session.organizationId, params.id, params.version);
  }

  @Post(':id/copy')
  @UseGuards(HumanSessionGuard)
  @ApiOperation({
    summary: 'Make my own version: a PRIVATE copy that credits its source and gets no updates',
    description:
      "Works on your own tool sets and on any you can see. Another organization's link-only " +
      'provider tools are not copied and are listed in `excluded`. 50 copies per UTC day.',
  })
  @ApiResponse({ status: 201, type: CopyResultDto })
  @ApiResponse({ status: 404, description: 'TOOLSET_NOT_FOUND — also when you cannot see it' })
  async copy(
    @CurrentSession() session: McpSession,
    @Param() params: ToolsetIdParamDto,
    @Body() body: CopyToolsetBodyDto,
  ): Promise<CopyResultDto> {
    return this.publishing.copy(session.organizationId, params.id, body, auditActorOf(session));
  }

  @Get(':id/stats')
  @ApiOperation({
    summary: 'Publisher dashboard: weekly figures, k = 5 on every cell, no buyer identities',
  })
  @ApiResponse({ status: 200, type: ToolsetOwnStatsDto })
  async stats(
    @CurrentSession() session: McpSession,
    @Param() params: ToolsetIdParamDto,
  ): Promise<ToolsetOwnStatsDto> {
    return this.publishing.ownStats(session.organizationId, params.id);
  }
}
