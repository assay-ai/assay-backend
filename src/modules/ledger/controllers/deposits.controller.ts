import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  AgentScope,
  CurrentSession,
  depositOwnerScope,
  RequireAgentScope,
  SessionAuthGuard,
} from '@shared/auth';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { DepositDto, ListDepositsQueryDto } from '../dto/list-deposits.dto';
import { DepositsService } from '../services/deposits.service';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

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
  @TenantCache({ ttl: 5, vary: 'org', epochs: ['money'] })
  @ApiOperation({ summary: 'Deposit intents, newest first, filterable by status' })
  @ApiCursorPage(DepositDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListDepositsQueryDto,
  ): Promise<CursorPageDto<DepositDto>> {
    return this.deposits.list(session.organizationId, query);
  }

  @Get(':depositId')
  @RequireAgentScope(AgentScope.ACTIVITY_READ)
  @TenantCache({ ttl: 5, vary: 'agent', epochs: ['money'] })
  @ApiOperation({
    summary: 'One deposit intent, in the same shape as the list row',
    description:
      'API credentials require activity:read and may read only their own agent deposits. ' +
      'Human sessions retain organization-wide access.',
  })
  @ApiResponse({ status: 200, description: 'The deposit', type: DepositDto })
  @ApiResponse({
    status: 404,
    description:
      "PAYMENT_DEPOSIT_NOT_FOUND — not this agent's (for an API credential) or not in this organization",
  })
  async getOne(
    @CurrentSession() session: McpSession,
    @Param('depositId', new ParseUUIDPipe()) depositId: string,
  ): Promise<DepositDto> {
    return this.deposits.getOne(depositOwnerScope(session), depositId);
  }
}
