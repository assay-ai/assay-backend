import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { CurrentOperator, OperatorAuthGuard } from '@shared/auth';

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
 * ## Why this is `OperatorAuthGuard` alone, and not `OperatorRolesGuard` /
 * `OperatorOverrideGuard` too
 *
 * `OperatorCasesController`'s docstring lays out three guards and what each
 * answers: *who is this* (`OperatorAuthGuard`), *may they do this kind of
 * thing* (`OperatorRolesGuard`), *is this recorded* (`OperatorOverrideGuard`).
 * This controller only needs the first, for two separate reasons:
 *
 * 1. **It is not an override.** `src/modules/operator/domain/override-register.ts`
 *    enumerates every action across six families — verification, policy,
 *    slashing, money, access, keys — and nothing in that taxonomy is "answer a
 *    ticket about a tool we don't have yet." Acknowledging, accepting or
 *    declining a request moves no money, touches no stake, changes no verdict
 *    and grants no access; it changes the ticket's own row and nothing else,
 *    the same reasoning `OperatorCasesController.claim` gives for its own
 *    `@OverrideExempt` ("changes nobody's money and nobody's state but the
 *    queue's"). Filing this under a register built for interventions with a
 *    blast radius would bury the interventions under ordinary queue work, and
 *    the register's own docstring is explicit that unimplemented rows must be
 *    named rather than invented ad hoc — there is no `T-*` family to cite.
 * 2. **There is no role for it.** `OperatorRole` enumerates SRE, ADJ, ADJL,
 *    POL, POLA, TRE, TREA, BD, SUP, CMP, SEC — built for the slashing,
 *    verification and policy domains. The tool request queue's owner is the
 *    "product lead", which is not one
 *    of them, and `override-register.ts` is not a file this module owns —
 *    inventing a role assignment here would be a guess dressed as a decision.
 *    `OperatorRolesGuard`'s own docstring draws the same line this controller
 *    does for reads: "being blocked from a decision needs a role, being
 *    blocked from a list would just be noise" — and answering a ticket is
 *    closer to the list than to a decision with a blast radius, in the sense
 *    that matters here (nothing it does is irreversible or moves value).
 *
 * If tool-request ownership later gets its own role or its own
 * register row, this is the seam: add the role to `OperatorRole`, add
 * `@RequireRoles` here, and — if it should be logged as an intervention after
 * all — add a row to the register and `@Override` the `answer` handler. Doing
 * either today would be inventing product decisions this module was not asked
 * to make.
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard)
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
