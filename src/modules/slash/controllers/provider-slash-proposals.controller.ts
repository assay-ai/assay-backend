import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  AllowedWhileBlocked,
  CurrentSession,
  HumanSessionGuard,
  SessionAuthGuard,
} from '@shared/auth';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { SlashProposalCaseDto, SlashProposalIdParamsDto } from '../dto/slash-proposal.dto';
import { SlashCaseService } from '../services/slash-case.service';
import { SlashProposalService } from '../services/slash-proposal.service';
import { BumpsOperatorConsole } from '@shared/decorators/tenant-write.decorator';

/**
 * The provider's own view of a penalty proposed against them: the case
 * screen. The dispute itself is `disputeSlash` on chain
 * (`POST /providers/me/slash-requests/dispute-intent` builds it).
 *
 * Organization-scoped in the ordinary way — a proposal belongs to the provider
 * whose stake it threatens, so `session.organizationId` is the query's own
 * tenant. The operator's cross-tenant queue is a separate controller behind a
 * separate guard, and the two never share a route.
 */
@ApiTags('Provider')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
// Writes here appear in the operator console's work lists.
@BumpsOperatorConsole()
@Controller('providers/me/slash-proposals')
export class ProviderSlashProposalsController {
  constructor(
    private readonly cases: SlashCaseService,
    private readonly lifecycle: SlashProposalService,
  ) {}

  @Get(':proposalId')
  @ApiOperation({ summary: 'One proposal, with everything the case screen renders' })
  @ApiResponse({ status: 200, type: SlashProposalCaseDto })
  @ApiResponse({ status: 404, description: 'No proposal of yours with this id' })
  async getCase(
    @CurrentSession() session: McpSession,
    @Param() params: SlashProposalIdParamsDto,
  ): Promise<SlashProposalCaseDto> {
    return this.cases.buildCase(session.organizationId, params.proposalId);
  }

  /**
   * Opening the case.
   *
   * Recorded, and it moves no clock. The provider's window runs to the
   * record's `executableAt`, never from reading — a provider who never opens
   * the dashboard has exactly as long to dispute as one who opens it
   * immediately.
   *
   * Allowed while blocked: it records a reading and grants nothing.
   */
  @Post(':proposalId/acknowledge')
  @UseGuards(HumanSessionGuard)
  @AllowedWhileBlocked()
  @ApiOperation({ summary: 'Record that the provider has seen this proposal' })
  @ApiResponse({ status: 200, type: SlashProposalCaseDto })
  async acknowledge(
    @CurrentSession() session: McpSession,
    @Param() params: SlashProposalIdParamsDto,
  ): Promise<SlashProposalCaseDto> {
    await this.lifecycle.acknowledge(session.organizationId, params.proposalId, session.agentId);
    return this.cases.buildCase(session.organizationId, params.proposalId);
  }
}
