import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import { CreateDisputeBodyDto } from '../dto/create-dispute.dto';
import { DisputeDto, DisputeIdParamsDto } from '../dto/dispute.dto';
import { ListDisputesQueryDto } from '../dto/list-disputes.dto';
import { DisputeService } from '../services/dispute.service';

/**
 * `GET /api/v1/disputes`, `GET /api/v1/disputes/:id`, `POST /api/v1/disputes`,
 * `POST /api/v1/disputes/:id/acknowledge`, `POST /api/v1/disputes/:id/withdraw`.
 *
 * `organizationId` comes from `@CurrentSession()` and nowhere else — see
 * `SessionAuthGuard`. Adjudication (who reviews, review SLA, partial-overturn
 * restoration) is not implemented and is not on this controller.
 */
@ApiTags('Disputes')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('disputes')
export class DisputesController {
  constructor(private readonly disputes: DisputeService) {}

  @Get()
  @ApiOperation({ summary: 'Disputes, newest first' })
  @ApiCursorPage(DisputeDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListDisputesQueryDto,
  ): Promise<CursorPageDto<DisputeDto>> {
    return this.disputes.list(session.organizationId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One dispute' })
  @ApiResponse({ status: 200, description: 'The dispute', type: DisputeDto })
  @ApiResponse({ status: 404, description: 'No such dispute in this organization' })
  async getById(
    @CurrentSession() session: McpSession,
    @Param() params: DisputeIdParamsDto,
  ): Promise<DisputeDto> {
    return this.disputes.getById(session.organizationId, params.id);
  }

  @Post()
  @ApiOperation({
    summary: 'Open a dispute against an SLA window, a verdict or a payment intent',
  })
  @ApiResponse({ status: 201, description: 'The dispute, OPEN', type: DisputeDto })
  @ApiResponse({
    status: 404,
    description: 'The named subject does not exist in this organization',
  })
  async create(
    @CurrentSession() session: McpSession,
    @Body() body: CreateDisputeBodyDto,
  ): Promise<DisputeDto> {
    return this.disputes.create(session.organizationId, session, body);
  }

  @Post(':id/acknowledge')
  @ApiOperation({
    summary: 'Acknowledge a dispute — starts the 72-hour response clock',
  })
  @ApiResponse({ status: 201, description: 'The dispute, acknowledged', type: DisputeDto })
  @ApiResponse({ status: 404, description: 'No such dispute in this organization' })
  @ApiResponse({ status: 409, description: 'Already acknowledged, or in a terminal state' })
  async acknowledge(
    @CurrentSession() session: McpSession,
    @Param() params: DisputeIdParamsDto,
  ): Promise<DisputeDto> {
    return this.disputes.acknowledge(session.organizationId, params.id);
  }

  @Post(':id/withdraw')
  @ApiOperation({ summary: 'Withdraw a dispute' })
  @ApiResponse({ status: 201, description: 'The dispute, WITHDRAWN', type: DisputeDto })
  @ApiResponse({ status: 404, description: 'No such dispute in this organization' })
  @ApiResponse({ status: 409, description: 'Already in a terminal state' })
  async withdraw(
    @CurrentSession() session: McpSession,
    @Param() params: DisputeIdParamsDto,
  ): Promise<DisputeDto> {
    return this.disputes.withdraw(session.organizationId, params.id);
  }
}
