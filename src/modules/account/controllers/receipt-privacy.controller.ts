import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { auditActorOf } from '@shared/audit';
import {
  AllowedWhileBlocked,
  CurrentSession,
  HumanSessionGuard,
  SessionAuthGuard,
} from '@shared/auth';

import { ReceiptPrivacyDto, SetReceiptPrivacyBodyDto } from '../dto/receipt-privacy.dto';
import { ReceiptPrivacyService } from '../services/receipt-privacy.service';

/**
 * "Show my receipts to anyone with the link" — the owner's switch for the public
 * receipt page. A person's act: an agent credential, even with every scope, is
 * refused (no `@RequireAgentScope`, `HumanSessionGuard`), so an agent cannot
 * publish or hide its owner's receipts. Allowed while blocked: hiding is a
 * privacy action and must not wait on a block being lifted.
 */
@ApiTags('Account')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard, HumanSessionGuard)
@Controller('account/receipt-privacy')
export class ReceiptPrivacyController {
  constructor(private readonly privacy: ReceiptPrivacyService) {}

  @Get()
  @AllowedWhileBlocked()
  @ApiOperation({ summary: 'Whether this account’s receipts are public' })
  @ApiResponse({ status: 200, type: ReceiptPrivacyDto })
  get(@CurrentSession() session: McpSession): Promise<ReceiptPrivacyDto> {
    return this.privacy.get(session.organizationId);
  }

  @Put()
  @AllowedWhileBlocked()
  @ApiOperation({ summary: 'Show or hide this account’s receipts on the public receipt page' })
  @ApiResponse({ status: 200, type: ReceiptPrivacyDto })
  set(
    @CurrentSession() session: McpSession,
    @Body() body: SetReceiptPrivacyBodyDto,
  ): Promise<ReceiptPrivacyDto> {
    return this.privacy.set(session.organizationId, body.receiptsPublic, auditActorOf(session));
  }
}
