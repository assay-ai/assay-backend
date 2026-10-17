import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import {
  CallDisputeDetailDto,
  CallDisputeDto,
  CallDisputeIdParamsDto,
  ListCallDisputesQueryDto,
  RespondCallDisputeBodyDto,
} from '../dto/call-dispute.dto';
import { CallDisputeService } from '../services/call-dispute.service';

/**
 * `GET /api/v1/providers/me/call-disputes`, `GET …/:id`, `POST …/:id/respond`.
 *
 * The disputes buyers filed over calls this provider served. Read by
 * `respondent_provider_id`, with `providerId == organizationId` for a provider
 * session (see `ProviderVerdictsController`). The buyer's organization is never
 * named. A dispute this provider did not serve is a 404.
 */
@ApiTags('Provider')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('providers/me/call-disputes')
export class ProviderCallDisputesController {
  constructor(private readonly disputes: CallDisputeService) {}

  @Get()
  @ApiOperation({ summary: 'Disputes over calls this provider served, newest first' })
  @ApiCursorPage(CallDisputeDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListCallDisputesQueryDto,
  ): Promise<CursorPageDto<CallDisputeDto>> {
    return this.disputes.listForProvider(session.organizationId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One dispute, with the call’s captured evidence' })
  @ApiResponse({ status: 200, type: CallDisputeDetailDto })
  @ApiResponse({ status: 404, description: 'No such dispute over a call this provider served' })
  async get(
    @CurrentSession() session: McpSession,
    @Param() params: CallDisputeIdParamsDto,
  ): Promise<CallDisputeDetailDto> {
    return this.disputes.getForProvider(session.organizationId, params.id);
  }

  @Post(':id/respond')
  @ApiOperation({ summary: 'Reply once, before the decision' })
  @ApiResponse({ status: 201, type: CallDisputeDetailDto })
  @ApiResponse({ status: 404, description: 'No such dispute over a call this provider served' })
  @ApiResponse({ status: 409, description: 'DISPUTE_ALREADY_RESPONDED — replied, or decided' })
  async respond(
    @CurrentSession() session: McpSession,
    @Param() params: CallDisputeIdParamsDto,
    @Body() body: RespondCallDisputeBodyDto,
  ): Promise<CallDisputeDetailDto> {
    return this.disputes.respond(session, params.id, body.response);
  }
}
