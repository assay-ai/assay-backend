import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import {
  GetStatementBalanceQueryDto,
  GetStatementBalanceResponseDto,
} from '../dto/get-statement-balance.dto';
import { StatementService } from '../services/statement.service';

/**
 * `GET /api/v1/statements/balance` — the money half of a monthly statement:
 * opening balance, deposits, withdrawals, paid and the closing balance, per
 * escrow. The call half is `GET /receipts/summary`. Read-only.
 */
@ApiTags('Statements')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('statements')
export class StatementsController {
  constructor(private readonly statements: StatementService) {}

  @Get('balance')
  @ApiOperation({ summary: 'Opening + deposits − withdrawals − paid = closing, per escrow' })
  @ApiResponse({ status: 200, type: GetStatementBalanceResponseDto })
  async balance(
    @CurrentSession() session: McpSession,
    @Query() query: GetStatementBalanceQueryDto,
  ): Promise<GetStatementBalanceResponseDto> {
    return this.statements.balance(
      session.organizationId,
      new Date(query.from),
      new Date(query.to),
    );
  }
}
