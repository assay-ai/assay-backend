import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentSession, SessionAuthGuard } from '@shared/auth';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { GetReceiptParamsDto, GetReceiptResponseDto } from '../dto/get-receipt.dto';
import {
  GetReceiptsSummaryQueryDto,
  GetReceiptsSummaryResponseDto,
} from '../dto/get-receipts-summary.dto';
import { ReceiptSummaryService } from '../services/receipt-summary.service';
import { ReceiptService } from '../services/receipt.service';

/**
 * One call's receipt, and the server-side summary the
 * dashboard, the export and the statement all read from.
 *
 * `organizationId` comes from `@CurrentSession()` and nowhere else — see
 * `SessionAuthGuard`. `summary` is routed before `:intentId` so it is never
 * captured as an intent id by the dynamic segment.
 */
@ApiTags('Receipts')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('receipts')
export class ReceiptsController {
  constructor(
    private readonly receipts: ReceiptService,
    private readonly summary: ReceiptSummaryService,
  ) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Per-group spend summary, with server-side grouping and period comparison',
  })
  @ApiResponse({ status: 200, description: 'The summary', type: GetReceiptsSummaryResponseDto })
  async getSummary(
    @CurrentSession() session: McpSession,
    @Query() query: GetReceiptsSummaryQueryDto,
  ): Promise<GetReceiptsSummaryResponseDto> {
    return this.summary.getSummary(session.organizationId, query);
  }

  @Get(':intentId')
  @ApiOperation({ summary: 'One call, fully — money and verification evidence joined' })
  @ApiResponse({ status: 200, description: 'The receipt', type: GetReceiptResponseDto })
  @ApiResponse({ status: 404, description: 'No such intent in this organization' })
  async getReceipt(
    @CurrentSession() session: McpSession,
    @Param() params: GetReceiptParamsDto,
  ): Promise<GetReceiptResponseDto> {
    return this.receipts.getReceipt(session.organizationId, params.intentId);
  }
}
