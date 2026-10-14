import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { CurrentOperator, OperatorAuthGuard, OperatorRolesGuard, RequireRoles } from '@shared/auth';

import { OverrideExempt } from '@modules/operator/decorators/override.decorator';
import { OperatorRole } from '@modules/operator/domain/override-register';
import { OperatorOverrideGuard } from '@modules/operator/guards/operator-override.guard';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';

import {
  AnswerToolRequestBodyDto,
  ListToolRequestQueueQueryDto,
  OperatorToolRequestQueueRowDto,
  ToolRequestDto,
  ToolRequestIdParamsDto,
} from '../dto/tool-request.dto';
import { ToolRequestQueueService } from '../services/operator-tool-request-queue.service';

/**
 * The operator side of the tool request queue.
 *
 * Reads are open to any operator, like the case queue. The one write, `PATCH`
 * (acknowledge, accept or decline a ticket), needs a role (security review
 * L-4): support or provider success own the queue, and the adjudication lead
 * can stand in. `OperatorRolesGuard` enforces it.
 *
 * It is not an override: answering a ticket moves no money, touches no stake,
 * changes no verdict and grants no access, so it carries a named exemption,
 * the same way `OperatorCasesController.claim` does. The ticket row keeps the
 * first operator who answered it as its owner (`owner_operator_id`).
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard, OperatorRolesGuard, OperatorOverrideGuard)
@Controller('operator/tool-requests')
export class OperatorToolRequestsController {
  constructor(private readonly queueService: ToolRequestQueueService) {}

  @Get()
  @ApiOperation({ summary: 'The queue: everything unanswered, oldest due date first' })
  @ApiCursorPage(OperatorToolRequestQueueRowDto)
  async queue(
    @Query() query: ListToolRequestQueueQueryDto,
  ): Promise<CursorPageDto<OperatorToolRequestQueueRowDto>> {
    return this.queueService.listQueue(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'The brief for one request, cross-organization by id' })
  @ApiResponse({ status: 200, type: ToolRequestDto })
  @ApiResponse({ status: 404, description: 'No such request' })
  async brief(@Param() params: ToolRequestIdParamsDto): Promise<ToolRequestDto> {
    return this.queueService.brief(params.id);
  }

  @Patch(':id')
  @OverrideExempt('Answers a ticket: moves no money and changes no case, stake or access')
  @RequireRoles(OperatorRole.SUP, OperatorRole.BD, OperatorRole.ADJL)
  @ApiOperation({ summary: 'Acknowledge, accept or decline — the whole MVP queue' })
  @ApiResponse({ status: 200, type: ToolRequestDto })
  @ApiResponse({ status: 404, description: 'No such request' })
  @ApiResponse({ status: 409, description: 'That move is not legal from the current state' })
  @ApiResponse({ status: 422, description: 'Accepting or declining needs a resolution note' })
  async answer(
    @CurrentOperator() operator: OperatorSession,
    @Param() params: ToolRequestIdParamsDto,
    @Body() body: AnswerToolRequestBodyDto,
  ): Promise<ToolRequestDto> {
    return this.queueService.answer(operator.operatorId, params.id, body);
  }
}
