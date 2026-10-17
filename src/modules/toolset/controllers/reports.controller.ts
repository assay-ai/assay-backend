import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { CurrentSession, HumanSessionGuard, SessionAuthGuard } from '@shared/auth';

import { CreateReportBodyDto, ReportDto } from '../dto/toolset-report.dto';
import { ToolsetReportsService } from '../services/toolset-reports.service';

/** `/reports` — report a tool set, a tool or a public name (design spec §7.9, FR-15). */
@ApiTags('Toolsets')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard, HumanSessionGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ToolsetReportsService) {}

  @Post()
  @ApiOperation({
    summary: 'Report a tool set, a tool or a public name to the operators',
    description:
      'Exactly one of toolsetId, toolId, handle. A link-only tool set needs its `unlistedToken`. ' +
      'One open report per item per organization; 20 a day.',
  })
  @ApiResponse({ status: 201, type: ReportDto })
  @ApiResponse({
    status: 404,
    description: 'TOOLSET_REPORT_TARGET_NOT_FOUND — also when you cannot see it',
  })
  @ApiResponse({ status: 409, description: 'TOOLSET_REPORT_DUPLICATE' })
  @ApiResponse({ status: 429, description: 'TOOLSET_LIMIT_EXCEEDED (reportsPerOrgPerDay)' })
  async create(
    @CurrentSession() session: McpSession,
    @Body() body: CreateReportBodyDto,
  ): Promise<ReportDto> {
    return this.reports.create(session.organizationId, body);
  }
}
