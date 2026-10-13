import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import {
  LookupSlashRequestsBodyDto,
  LookupSlashRequestsResponseDto,
} from '../dto/slash-request-lookup.dto';
import { SlashRequestLookupService } from '../services/slash-request-lookup.service';

/**
 * On-chain slash request ids, matched to the provider's own cases.
 *
 * A `POST` because the question is a list of up to 200 ids, which does not fit
 * a query string; it writes nothing and answers `200`.
 */
@ApiTags('Provider')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('providers/me/slash-requests')
export class ProviderSlashRequestsController {
  constructor(private readonly lookups: SlashRequestLookupService) {}

  @Post('lookup')
  @HttpCode(200)
  @ApiOperation({ summary: 'Which of these on-chain slash request ids are your Assay cases' })
  @ApiResponse({ status: 200, type: LookupSlashRequestsResponseDto })
  async lookup(
    @CurrentSession() session: McpSession,
    @Body() body: LookupSlashRequestsBodyDto,
  ): Promise<LookupSlashRequestsResponseDto> {
    return this.lookups.lookup(session.organizationId, body.requestIds);
  }
}
