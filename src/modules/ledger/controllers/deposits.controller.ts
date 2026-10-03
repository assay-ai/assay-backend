import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentSession, SessionAuthGuard } from '@shared/auth';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { DepositDto, ListDepositsQueryDto } from '../dto/list-deposits.dto';
import { DepositsService } from '../services/deposits.service';

/**
 * `GET /api/v1/deposits` — the deposit history behind the funding screen.
 *
 * **The `deposits` prefix is split across two Nest modules on purpose.** The
 * two writes — `POST /deposits` and `POST /deposits/:id/settle` — are
 * `PaymentApiModule`'s (`modules/payment/controllers/deposits.controller.ts`),
 * because `DepositService` lives in `payment/`; listing is a ledger read and
 * lives here. Nest allows this. A reader grepping for one route will not find
 * the other, so each file names the other — keep both docs in step.
 */
@ApiTags('Deposits')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('deposits')
export class DepositsController {
  constructor(private readonly deposits: DepositsService) {}

  @Get()
  @ApiOperation({ summary: 'Deposit intents, newest first, filterable by status' })
  @ApiCursorPage(DepositDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListDepositsQueryDto,
  ): Promise<CursorPageDto<DepositDto>> {
    return this.deposits.list(session.organizationId, query);
  }
}
