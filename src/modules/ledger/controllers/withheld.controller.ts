import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentSession, SessionAuthGuard } from '@shared/auth';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { GetWithheldQueryDto, GetWithheldResponseDto } from '../dto/get-withheld.dto';
import { BalancesService } from '../services/balances.service';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

/**
 * `GET /api/v1/withheld` — the `withheld` aggregate on its own,
 * windowed by `from`/`to` and decomposed by terminal state.
 *
 * `GET /balances` already carries the all-time figure alongside the balances
 * it reconciles against; this endpoint exists for the dashboard screens that need
 * the *same* figure over a period the user picks — "this month", "last 30
 * days" — without re-fetching balances to get it.
 */
@ApiTags('Withheld')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('withheld')
export class WithheldController {
  constructor(private readonly balances: BalancesService) {}

  @Get()
  @TenantCache({ ttl: 5, vary: 'org', epochs: ['money'], singleFlight: true })
  @ApiOperation({
    summary: 'The `withheld` aggregate — call count, decomposed by terminal state',
  })
  @ApiResponse({ status: 200, description: 'Withheld, per asset', type: GetWithheldResponseDto })
  async getWithheld(
    @CurrentSession() session: McpSession,
    @Query() query: GetWithheldQueryDto,
  ): Promise<GetWithheldResponseDto> {
    const withheld = await this.balances.getWithheld(session.organizationId, {
      from: query.from,
      to: query.to,
    });

    return { withheld };
  }
}
