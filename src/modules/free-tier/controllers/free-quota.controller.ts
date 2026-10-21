import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import { FreeQuotaResponseDto } from '../dto/free-quota-response.dto';
import { FreeQuotaService } from '../services/free-quota.service';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

/**
 * `GET /api/v1/free-quota`.
 *
 * Read-only, and deliberately cheap: every figure comes off
 * `FreeQuotaService`'s **read** paths (`platformRemaining`, `rateLimitRemaining`,
 * `remainingByTool`), never `check` or `consume` — this endpoint answers "how
 * much is left", it does not gate a call and it must not spend anything just
 * because an agent asked.
 */
@ApiTags('Free tier')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('free-quota')
export class FreeQuotaController {
  constructor(private readonly quota: FreeQuotaService) {}

  @Get()
  @TenantCache({ ttl: 5, vary: 'agent', epochs: ['money'], singleFlight: true })
  @ApiOperation({ summary: "This agent's own free-tier standing" })
  @ApiResponse({ status: 200, type: FreeQuotaResponseDto })
  async get(@CurrentSession() session: McpSession): Promise<FreeQuotaResponseDto> {
    const [platform, rateLimit, tools] = await Promise.all([
      this.quota.platformRemaining(session.organizationId, session.agentId),
      this.quota.rateLimitRemaining(session.agentId),
      this.quota.remainingByTool(session.organizationId, session.agentId),
    ]);

    return {
      platform: {
        remaining: platform.remaining,
        limit: platform.limit,
        resetsAt: platform.resetsAt.toISOString(),
      },
      rateLimit: {
        remaining: rateLimit.remaining,
        limit: rateLimit.limit,
        resetsAt: rateLimit.resetsAt.toISOString(),
      },
      tools: tools.map((tool) => ({
        toolId: tool.toolId,
        remaining: tool.remaining,
        limit: tool.limit,
        resetsAt: tool.resetsAt.toISOString(),
      })),
    };
  }
}
