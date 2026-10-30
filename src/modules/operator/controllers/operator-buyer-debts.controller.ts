import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentOperator, OperatorAuthGuard, OperatorRolesGuard, RequireRoles } from '@shared/auth';

import { Override } from '../decorators/override.decorator';
import { OperatorRole } from '../domain/override-register';
import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import {
  ListOperatorBuyerDebtsQueryDto,
  OperatorBuyerDebtPageDto,
  RequestBuyerDebtVoidBodyDto,
} from '../dto/operator-buyer-debts.dto';
import { OperatorOverrideGuard } from '../guards/operator-override.guard';
import { OperatorSession } from '../ports/operator-session.port';
import { OperatorBuyerDebtService } from '../services/operator-buyer-debt.service';

/**
 * `GET /operator/buyer-debts`, `POST /operator/buyer-debts/void`.
 *
 * Open buyer debts across every organization, and their bulk void (`M-1`,
 * owner decision 2026-10-30): a lapsed voucher is always buyer debt, and only
 * two operators together may void debts the platform caused. The void route
 * always answers 202: a second operator approves it through
 * `POST /operator/approvals/:approvalId/approve`, whose `result` is the
 * per-id outcome (`BuyerDebtVoidResultDto`).
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard, OperatorRolesGuard, OperatorOverrideGuard)
@Controller('operator/buyer-debts')
export class OperatorBuyerDebtsController {
  constructor(private readonly debts: OperatorBuyerDebtService) {}

  @Get()
  @RequireRoles(OperatorRole.TRE, OperatorRole.ADJL, OperatorRole.ADJ, OperatorRole.SRE)
  @ApiOperation({
    summary: 'Open buyer debts, newest lapse first, with totals of everything the filters match',
  })
  @ApiResponse({ status: 200, type: OperatorBuyerDebtPageDto })
  async list(@Query() query: ListOperatorBuyerDebtsQueryDto): Promise<OperatorBuyerDebtPageDto> {
    return this.debts.list(query);
  }

  /**
   * `M-1`. Requests the void of these debts; always queued for a second
   * operator (`TRE` or `ADJL`, not the requester), who approves exactly the
   * pinned ids, asset and total.
   */
  @Post('void')
  @Override('M-1')
  @RequireRoles(OperatorRole.TRE, OperatorRole.ADJL)
  @HttpCode(202)
  @ApiOperation({ summary: 'Request a bulk void of buyer debts (queued for a second operator)' })
  @ApiResponse({
    status: 202,
    description: 'Queued for a second operator',
    type: ApprovalQueuedDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'OPERATOR_DEBT_VOID_INVALID: an id is not an open buyer debt (`intentIds` names them), ' +
      'the ids span more than one asset, or more than 500 ids',
  })
  @ApiResponse({ status: 403, description: 'OPERATOR_ROLE_REQUIRED / OPERATOR_AUTHORITY_EXCEEDED' })
  async requestVoid(
    @CurrentOperator() operator: OperatorSession,
    @Body() body: RequestBuyerDebtVoidBodyDto,
  ): Promise<ApprovalQueuedDto> {
    return this.debts.requestVoid({
      operator,
      intentIds: body.intentIds,
      reason: body.reason,
      ticketRef: body.ticketRef ?? null,
    });
  }
}
