import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import {
  CreateToolRequestBodyDto,
  ListToolRequestsQueryDto,
  ToolRequestDto,
  ToolRequestIdParamsDto,
} from '../dto/tool-request.dto';
import { ToolRequestService } from '../services/tool-request.service';
import { BumpsOperatorConsole } from '@shared/decorators/tenant-write.decorator';

/**
 * The tool request form and the requester's own view of it.
 *
 * `organizationId` comes from `@CurrentSession()` and is the requester's *own*
 * tenant here — unlike `payment_intents` / `verification_records`, where it is
 * the payer's org and a provider reads by a separate `provider_id` instead
 * (see `ProviderVerdictsController`). A tool request has one party, and this
 * controller is that party's own surface: an ordinary
 * `SessionAuthGuard` + `OrganizationScopedRepository` route, no tautology
 * needed.
 *
 * There is deliberately no `PATCH` here and no way to withdraw or edit a
 * filed request. This is a ticket queue, not a proposal workflow — see
 * `CreateToolRequestBodyDto`'s docstring — and the only writer of `status`
 * after filing is the operator queue (`OperatorToolRequestsController`).
 */
@ApiTags('Tool requests')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
// Writes here appear in the operator console's work lists.
@BumpsOperatorConsole()
@Controller('tool-requests')
export class ToolRequestsController {
  constructor(private readonly requests: ToolRequestService) {}

  @Post()
  @ApiOperation({ summary: 'File a request for a tool we do not have' })
  @ApiResponse({ status: 201, type: ToolRequestDto })
  async file(
    @CurrentSession() session: McpSession,
    @Body() body: CreateToolRequestBodyDto,
  ): Promise<ToolRequestDto> {
    return this.requests.file(session.organizationId, session.agentId, body);
  }

  @Get()
  @ApiOperation({ summary: 'Requests filed by this organization' })
  @ApiCursorPage(ToolRequestDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListToolRequestsQueryDto,
  ): Promise<CursorPageDto<ToolRequestDto>> {
    return this.requests.list(session.organizationId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One request, and how long we said it would take' })
  @ApiResponse({ status: 200, type: ToolRequestDto })
  @ApiResponse({ status: 404, description: 'No request of yours with this id' })
  async get(
    @CurrentSession() session: McpSession,
    @Param() params: ToolRequestIdParamsDto,
  ): Promise<ToolRequestDto> {
    return this.requests.get(session.organizationId, params.id);
  }
}
