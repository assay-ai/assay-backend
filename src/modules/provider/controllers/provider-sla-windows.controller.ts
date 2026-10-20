import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import {
  GetSlaWindowEvidenceParamsDto,
  GetSlaWindowEvidenceResponseDto,
  GetSlaWindowParamsDto,
  GetSlaWindowResponseDto,
  ListSlaWindowsQueryDto,
  SlaWindowSummaryDto,
} from '../dto/get-sla-windows.dto';
import { ProviderSlaWindowsService } from '../services/provider-sla-windows.service';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

/**
 * `sla_windows` / `sla_window_calls` — the provider's own read side. Three
 * endpoints, all organization-scoped in the ordinary way: a
 * window belongs to the provider it measures, so `session.organizationId` is
 * the query's own tenant, not a cross-organization report.
 */
@ApiTags('Provider')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('providers/me/sla-windows')
export class ProviderSlaWindowsController {
  constructor(private readonly slaWindows: ProviderSlaWindowsService) {}

  @Get()
  @TenantCache({ ttl: 30, vary: 'org', epochs: ['provider'] })
  @ApiOperation({ summary: 'This provider’s SLA windows, newest first by default' })
  @ApiCursorPage(SlaWindowSummaryDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListSlaWindowsQueryDto,
  ): Promise<CursorPageDto<SlaWindowSummaryDto>> {
    return this.slaWindows.listWindows(session.organizationId, query);
  }

  @Get(':windowId')
  @TenantCache({ ttl: 30, vary: 'org', epochs: ['provider'] })
  @ApiOperation({ summary: 'One window’s full live position' })
  @ApiResponse({ status: 200, type: GetSlaWindowResponseDto })
  @ApiResponse({ status: 404, description: 'No window of yours with this id' })
  async getOne(
    @CurrentSession() session: McpSession,
    @Param() params: GetSlaWindowParamsDto,
  ): Promise<GetSlaWindowResponseDto> {
    return this.slaWindows.getWindow(session.organizationId, params.windowId);
  }

  @Get(':windowId/evidence')
  @ApiOperation({
    summary: 'The evidence pack for one window — retrievable for any window, not only slashed ones',
  })
  @ApiResponse({ status: 200, type: GetSlaWindowEvidenceResponseDto })
  @ApiResponse({ status: 404, description: 'No window of yours with this id' })
  async getEvidence(
    @CurrentSession() session: McpSession,
    @Param() params: GetSlaWindowEvidenceParamsDto,
  ): Promise<GetSlaWindowEvidenceResponseDto> {
    return this.slaWindows.getEvidence(session.organizationId, params.windowId);
  }
}
