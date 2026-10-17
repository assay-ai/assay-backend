import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import {
  BuyerDisputeHistoryDto,
  DecideCallDisputeBodyDto,
  ListOperatorCallDisputesQueryDto,
  OperatorCallDisputeDetailDto,
  OperatorCallDisputeRowDto,
} from '@modules/dispute/dto/call-dispute.dto';
import { CallDisputeService } from '@modules/dispute/services/call-dispute.service';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { CurrentOperator, OperatorAuthGuard, OperatorRolesGuard, RequireRoles } from '@shared/auth';
import { RequestContext } from '@shared/observability';

import { Override } from '../decorators/override.decorator';
import { OperatorRole } from '../domain/override-register';
import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import { OperatorOverrideGuard } from '../guards/operator-override.guard';
import { OperatorSession } from '../ports/operator-session.port';
import { OperatorCallDisputeService } from '../services/operator-call-dispute.service';
import { answerOrQueued } from './approval-response';

/**
 * `GET /operator/call-disputes`, `GET /operator/call-disputes/:id`,
 * `POST /operator/call-disputes/:id/decide`,
 * `GET /operator/call-disputes/buyers/:organizationId`.
 *
 * The queue of buyer disputes over paid calls (G3.B1), across tenants. Every
 * row carries the buyer's recent dispute history, so a buyer whose disputes
 * are mostly rejected is visible on the row (`buyerHistory.flagged`) and can be
 * filtered (`flaggedOnly`).
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard, OperatorRolesGuard, OperatorOverrideGuard)
@Controller('operator/call-disputes')
export class OperatorCallDisputesController {
  constructor(
    private readonly disputes: CallDisputeService,
    private readonly operatorDisputes: OperatorCallDisputeService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Buyer call disputes, newest first (filter state=OPEN for the queue)' })
  @ApiCursorPage(OperatorCallDisputeRowDto)
  async list(
    @Query() query: ListOperatorCallDisputesQueryDto,
  ): Promise<CursorPageDto<OperatorCallDisputeRowDto>> {
    return this.disputes.listForOperator(query);
  }

  @Get('buyers/:organizationId')
  @ApiOperation({ summary: 'One buyer’s dispute history and filing limit' })
  @ApiResponse({ status: 200, type: BuyerDisputeHistoryDto })
  async buyer(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ): Promise<BuyerDisputeHistoryDto> {
    return this.disputes.buyerHistory(organizationId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One dispute: the call, its input and output, the verdict, provider and binding',
  })
  @ApiResponse({ status: 200, type: OperatorCallDisputeDetailDto })
  @ApiResponse({ status: 404, description: 'No such call dispute' })
  async detail(@Param('id', ParseUUIDPipe) id: string): Promise<OperatorCallDisputeDetailDto> {
    return this.operatorDisputes.detail(id);
  }

  /**
   * `S-14`. Uphold (refund the buyer as far as the money allows, and count the
   * call against the binding's quality) or reject, with a note both parties
   * see. An upheld decision at or above the threshold is queued (202) for a
   * second operator.
   */
  @Post(':id/decide')
  @Override('S-14')
  @RequireRoles(OperatorRole.ADJ, OperatorRole.ADJL)
  @HttpCode(200)
  @ApiOperation({ summary: 'Uphold or reject a buyer’s dispute over a call' })
  @ApiResponse({ status: 200, type: OperatorCallDisputeDetailDto })
  @ApiResponse({
    status: 202,
    description: 'Queued for a second operator',
    type: ApprovalQueuedDto,
  })
  @ApiResponse({
    status: 409,
    description: 'DISPUTE_NOT_DECIDABLE (decided or withdrawn) or DISPUTE_COLLECTION_IN_PROGRESS',
  })
  async decide(
    @CurrentOperator() operator: OperatorSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecideCallDisputeBodyDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OperatorCallDisputeDetailDto | ApprovalQueuedDto> {
    const result = await this.operatorDisputes.decide({
      operator,
      disputeId: id,
      decision: body.decision,
      note: body.note,
      ticketRef: body.ticketRef ?? null,
      requestId: RequestContext.getServerRequestId(),
    });
    return answerOrQueued(response, result);
  }
}
