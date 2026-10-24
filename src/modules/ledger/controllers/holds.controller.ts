import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AgentScope, CurrentSession, RequireAgentScope, SessionAuthGuard } from '@shared/auth';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { HoldDto, ListHoldsQueryDto } from '../dto/list-holds.dto';
import { HoldsService } from '../services/holds.service';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

/**
 * `GET /api/v1/holds` — enumerated holds, `OPEN` by default.
 *
 * Feeds the overview aggregate, the funding screen's "View holds", the
 * blocking-hold explanation on a withdrawal shortfall, and close-account's
 * enumerated blocking holds.
 */
@ApiTags('Holds')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@RequireAgentScope(AgentScope.ACTIVITY_READ)
@Controller('holds')
export class HoldsController {
  constructor(private readonly holds: HoldsService) {}

  @Get()
  @TenantCache({ ttl: 5, vary: 'org', epochs: ['money'] })
  @ApiOperation({ summary: 'Holds, OPEN by default, newest first' })
  @ApiCursorPage(HoldDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListHoldsQueryDto,
  ): Promise<CursorPageDto<HoldDto>> {
    return this.holds.list(session.organizationId, query);
  }
}
