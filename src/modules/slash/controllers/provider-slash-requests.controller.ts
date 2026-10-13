import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { BlockedSessionReadOnly, CurrentSession, SessionAuthGuard } from '@shared/auth';

import {
  LookupSlashRequestsBodyDto,
  LookupSlashRequestsResponseDto,
} from '../dto/slash-request-lookup.dto';
import { DisputeSlashRequestsBodyDto, SlashContractCallDto } from '../dto/slash-dispute-intent.dto';
import { SlashDisputeIntentService } from '../services/slash-dispute-intent.service';
import { SlashRequestLookupService } from '../services/slash-request-lookup.service';

/**
 * On-chain slash request ids, matched to the provider's own cases.
 *
 * A `POST` because the question is a list of up to 200 ids, which does not fit
 * a query string; it writes nothing and answers `200`. So it is marked
 * `@BlockedSessionReadOnly()`: a blocked provider may still ask, and most needs
 * to — its pending penalties are what the block is about.
 */
@ApiTags('Provider')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('providers/me/slash-requests')
export class ProviderSlashRequestsController {
  constructor(
    private readonly lookups: SlashRequestLookupService,
    private readonly disputes: SlashDisputeIntentService,
  ) {}

  @Post('lookup')
  @BlockedSessionReadOnly()
  @HttpCode(200)
  @ApiOperation({ summary: 'Which of these on-chain slash request ids are your Assay cases' })
  @ApiResponse({ status: 200, type: LookupSlashRequestsResponseDto })
  async lookup(
    @CurrentSession() session: McpSession,
    @Body() body: LookupSlashRequestsBodyDto,
  ): Promise<LookupSlashRequestsResponseDto> {
    return this.lookups.lookup(session.organizationId, body.requestIds);
  }

  /**
   * The unsigned `disputeSlashBatch` (assay-evm D-19) for YOUR stake wallet on
   * `chainId`, 1 to 64 records at once. Every id is checked against the record
   * first — yours, `PENDING`, and its dispute window (`executableAt − now`, the
   * chain's slash delay, not a fixed 72 h) still open — because the batch is
   * atomic and one bad id reverts it all; a refusal names each id (422).
   *
   * Open to a blocked person's session: the chain lets a blocked provider
   * dispute, and building a transaction writes nothing here. The provider's
   * wallet signs and sends it; the case shows "disputed on chain" once the
   * watcher sees it land.
   */
  @Post('dispute-intent')
  @BlockedSessionReadOnly()
  @HttpCode(200)
  @ApiOperation({ summary: 'Build the unsigned on-chain dispute of your slash records' })
  @ApiResponse({ status: 200, type: SlashContractCallDto })
  @ApiResponse({ status: 409, description: 'No dispute upgrade on this chain yet' })
  @ApiResponse({ status: 422, description: 'One or more ids would revert the batch' })
  async disputeIntent(
    @CurrentSession() session: McpSession,
    @Body() body: DisputeSlashRequestsBodyDto,
  ): Promise<SlashContractCallDto> {
    const call = await this.disputes.providerDispute(
      session.organizationId,
      body.chainId,
      body.requestIds,
    );
    return { ...call, requestIds: [...call.requestIds] };
  }
}
