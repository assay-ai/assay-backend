import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import { ListWithdrawalsResponseDto } from '../dto/list-withdrawals.dto';
import { WithdrawalsService } from '../services/withdrawals.service';

/**
 * `GET /api/v1/withdrawals` — the withdrawal history behind the funding
 * screen, beside `GET /deposits`. The organization comes from the session and
 * nowhere else. The live pending request is `GET /escrow`'s
 * `withdrawRequested` / `withdrawAvailableAt`; this list trails the chain by
 * the index's confirmation depth.
 */
@ApiTags('Withdrawals')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('withdrawals')
export class WithdrawalsController {
  constructor(private readonly withdrawals: WithdrawalsService) {}

  @Get()
  @ApiOperation({ summary: 'Withdrawals from this buyer’s escrows, newest first' })
  @ApiResponse({ status: 200, type: ListWithdrawalsResponseDto })
  async list(@CurrentSession() session: McpSession): Promise<ListWithdrawalsResponseDto> {
    return this.withdrawals.list(session.organizationId);
  }
}
