import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import { OverviewQueryDto, OverviewResponseDto } from '../dto/overview.dto';
import { OverviewService } from '../services/overview.service';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

/**
 * `GET /api/v1/overview` — the buyer Overview in one read. See
 * `OverviewService`.
 *
 * `SessionAuthGuard` alone, like every route it stands for (`/balances`,
 * `/holds`, `/withheld`, `/receipts/summary`, `/tool-calls`,
 * `/notifications`): none of them is a person-only read, so this is not
 * either. `organizationId` comes from `@CurrentSession()` and nowhere else.
 */
@ApiTags('Overview')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('overview')
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get()
  @TenantCache({ ttl: 5, vary: 'org', epochs: ['money', 'notifications'], singleFlight: true })
  @ApiOperation({
    summary: 'Balances, holds, withheld, summaries, the 7-day chart, recent calls and alerts',
  })
  @ApiResponse({ status: 200, description: 'The overview', type: OverviewResponseDto })
  async get(
    @CurrentSession() session: McpSession,
    @Query() query: OverviewQueryDto,
  ): Promise<OverviewResponseDto> {
    return this.overview.get(session.organizationId, query);
  }
}
