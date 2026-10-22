import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { RefundEligibilityService } from '@modules/dispute/services/refund-eligibility.service';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { AgentScope, CurrentSession, RequireAgentScope, SessionAuthGuard } from '@shared/auth';
import { ApiCursorPage, CursorPageDto } from '@shared/api';

import { GetToolCallParamsDto } from '../dto/get-tool-call.dto';
import {
  ListToolCallsQueryDto,
  ToolCallDto,
  ToolCallListItemDto,
} from '../dto/list-tool-calls.dto';
import { ToolCallsService } from '../services/tool-calls.service';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

/**
 * The call list every buyer screen opens with.
 *
 * `organizationId` comes from `@CurrentSession()` and nowhere else — see
 * `SessionAuthGuard`. `GET /:intentId` is the same row shape as the list, not
 * the full evidence receipt — that is `GET /receipts/:intentId`, owned by the
 * verification module.
 */
@ApiTags('ToolCalls')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@RequireAgentScope(AgentScope.ACTIVITY_READ)
@Controller('tool-calls')
export class ToolCallsController {
  constructor(
    private readonly toolCalls: ToolCallsService,
    // `refundable=true` answers with the receipt's own read-only predicate.
    private readonly refunds: RefundEligibilityService,
  ) {}

  @Get()
  @TenantCache({ ttl: 5, vary: 'org', epochs: ['money', 'disputes'] })
  @ApiOperation({
    summary:
      'Tool calls, newest first — filterable by status, tool, provider, verdict, and calls ' +
      'still refundable if reported now; `include=free` adds the served free calls (`kind`)',
  })
  @ApiCursorPage(ToolCallDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListToolCallsQueryDto,
  ): Promise<CursorPageDto<ToolCallListItemDto>> {
    return this.toolCalls.list(session.organizationId, query, (calls, now) =>
      this.refunds.ofCalls(calls, now),
    );
  }

  @Get(':intentId')
  @ApiOperation({ summary: 'One call, in the same shape as the list row' })
  @ApiResponse({ status: 200, description: 'The call', type: ToolCallDto })
  @ApiResponse({ status: 404, description: 'No such intent in this organization' })
  async getOne(
    @CurrentSession() session: McpSession,
    @Param() params: GetToolCallParamsDto,
  ): Promise<ToolCallDto> {
    return this.toolCalls.getOne(session.organizationId, params.intentId);
  }
}
