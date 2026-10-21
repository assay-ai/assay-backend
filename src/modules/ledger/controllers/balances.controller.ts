import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentSession, SessionAuthGuard } from '@shared/auth';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { GetBalancesResponseDto } from '../dto/get-balances.dto';
import { BalancesService } from '../services/balances.service';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

/**
 * The account's balances, and `withheld` beside them so the
 * guarantee is checkable from the same call a wallet screen would make.
 *
 * `organizationId` comes from `@CurrentSession()` and nowhere else — see
 * `SessionAuthGuard` for why a query parameter is not an option here.
 */
@ApiTags('Balances')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('balances')
export class BalancesController {
  constructor(private readonly balances: BalancesService) {}

  @Get()
  @TenantCache({ ttl: 5, vary: 'org', epochs: ['money'], singleFlight: true })
  @ApiOperation({
    summary: "The organization's balances, plus withheld with its reconciliation",
  })
  @ApiResponse({ status: 200, description: 'Balances and withheld', type: GetBalancesResponseDto })
  async getBalances(@CurrentSession() session: McpSession): Promise<GetBalancesResponseDto> {
    return this.balances.getBalances(session.organizationId);
  }
}
