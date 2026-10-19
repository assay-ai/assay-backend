import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { CurrentSession, HumanSessionGuard, SessionAuthGuard } from '@shared/auth';

import {
  ListRefusedCallsQueryDto,
  RefusedCallDto,
  RefusedCallParamsDto,
} from '../dto/refused-call.dto';
import { RefusedCallsService } from '../services/refused-calls.service';

/**
 * Calls refused before anything was charged: the Calls page's "Refused"
 * filter, and the page an agent's `fixUrl` (`/spend/calls?call={id}`) opens.
 */
@ApiTags('RefusedCalls')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard, HumanSessionGuard)
@Controller('refused-calls')
export class RefusedCallsController {
  constructor(private readonly refused: RefusedCallsService) {}

  @Get()
  @ApiOperation({ summary: 'Refused calls, newest first; filter by agent' })
  @ApiCursorPage(RefusedCallDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListRefusedCallsQueryDto,
  ): Promise<CursorPageDto<RefusedCallDto>> {
    return this.refused.list(session.organizationId, query);
  }

  @Get(':callId')
  @ApiOperation({ summary: 'One refused call, with the reason and source per provider' })
  @ApiResponse({ status: 200, type: RefusedCallDto })
  @ApiResponse({ status: 404, description: 'TOOLSET_REFUSED_CALL_NOT_FOUND' })
  async get(
    @CurrentSession() session: McpSession,
    @Param() params: RefusedCallParamsDto,
  ): Promise<RefusedCallDto> {
    return this.refused.get(session.organizationId, params.callId);
  }
}
