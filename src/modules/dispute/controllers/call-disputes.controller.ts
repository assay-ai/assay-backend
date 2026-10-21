import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import {
  CallDisputeDetailDto,
  CallDisputeDto,
  CallDisputeIdParamsDto,
  CreateCallDisputeBodyDto,
  ListCallDisputesQueryDto,
} from '../dto/call-dispute.dto';
import { CallDisputeService } from '../services/call-dispute.service';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';
import { BumpsOperatorConsole } from '@shared/decorators/tenant-write.decorator';

/**
 * `POST /api/v1/call-disputes`, `GET /api/v1/call-disputes`,
 * `GET /api/v1/call-disputes/:id`, `POST /api/v1/call-disputes/:id/withdraw`.
 *
 * A buyer's dispute over one paid call it made (G3.B1) — the "Report a bad
 * result" button on the receipt. Scoped to the caller's own organization; a
 * call or dispute of another tenant is a 404.
 */
@ApiTags('Call disputes')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
// Writes here appear in the operator console's work lists.
@BumpsOperatorConsole()
@Controller('call-disputes')
export class CallDisputesController {
  constructor(private readonly disputes: CallDisputeService) {}

  @Post()
  @ApiOperation({
    summary: 'Dispute a paid call (by payment intent or verdict id)',
    description:
      'One open dispute per call, within the filing window after the call settled. The ' +
      'call’s input, output and verdict are captured now, so the decision does not depend on ' +
      'evidence that retention later scrubs. Rate-limited per organization; a buyer whose ' +
      'recent disputes are mostly rejected gets a tighter limit.',
  })
  @ApiResponse({ status: 201, type: CallDisputeDetailDto })
  @ApiResponse({ status: 404, description: 'No such call or verdict in this organization' })
  @ApiResponse({
    status: 409,
    description:
      'DISPUTE_CALL_NOT_DISPUTABLE, DISPUTE_FILING_WINDOW_CLOSED or DISPUTE_ALREADY_OPEN',
  })
  @ApiResponse({ status: 429, description: 'DISPUTE_RATE_LIMITED' })
  async file(
    @CurrentSession() session: McpSession,
    @Body() body: CreateCallDisputeBodyDto,
  ): Promise<CallDisputeDetailDto> {
    return this.disputes.file(session, body);
  }

  @Get()
  @TenantCache({ ttl: 10, vary: 'org', epochs: ['disputes'] })
  @ApiOperation({ summary: 'This organization’s call disputes, newest first' })
  @ApiCursorPage(CallDisputeDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListCallDisputesQueryDto,
  ): Promise<CursorPageDto<CallDisputeDto>> {
    return this.disputes.listForBuyer(session.organizationId, query);
  }

  @Get(':id')
  @TenantCache({ ttl: 10, vary: 'org', epochs: ['disputes'] })
  @ApiOperation({ summary: 'One call dispute, with its captured evidence' })
  @ApiResponse({ status: 200, type: CallDisputeDetailDto })
  @ApiResponse({ status: 404, description: 'No such dispute in this organization' })
  async get(
    @CurrentSession() session: McpSession,
    @Param() params: CallDisputeIdParamsDto,
  ): Promise<CallDisputeDetailDto> {
    return this.disputes.getForBuyer(session.organizationId, params.id);
  }

  @Post(':id/withdraw')
  // A state change of an existing report, not a creation.
  @HttpCode(200)
  @ApiOperation({ summary: 'Withdraw an open call dispute' })
  @ApiResponse({ status: 200, type: CallDisputeDto })
  @ApiResponse({ status: 404, description: 'No such dispute in this organization' })
  @ApiResponse({ status: 409, description: 'Already decided or withdrawn' })
  async withdraw(
    @CurrentSession() session: McpSession,
    @Param() params: CallDisputeIdParamsDto,
  ): Promise<CallDisputeDto> {
    return this.disputes.withdraw(session, params.id);
  }
}
