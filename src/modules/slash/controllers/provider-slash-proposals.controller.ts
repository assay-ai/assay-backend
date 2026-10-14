import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEnum, IsString, Length, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { AllowedWhileBlocked, CurrentSession, HumanSessionGuard, SessionAuthGuard } from '@shared/auth';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { DisputeClaimType } from '../domain/arbitration';
import {
  RestorationRowDto,
  SlashProposalCaseDto,
  SlashProposalEventDto,
  SlashProposalIdParamsDto,
} from '../dto/slash-proposal.dto';
import { ArbitrationService } from '../services/arbitration.service';
import { SlashCaseService } from '../services/slash-case.service';
import { SlashProposalService } from '../services/slash-proposal.service';

/**
 * The dispute filing form, as a body.
 *
 * The clearest transferable lesson from other dispute systems: *"Structure the
 * input, not just the output."* Every dispute system with tolerable review
 * consistency constrains what the accused party may submit. `POST /disputes`
 * takes `{ reason, evidence }` as free text, and that single choice is what
 * guarantees inconsistent review — two adjudicators reading two essays
 * about the same situation do not extract the same facts.
 *
 * So `claimType` is a closed enum and the free text is the *supplement*, not
 * the submission.
 */
export class FileSlashDisputeBodyDto {
  @ApiProperty({ enum: DisputeClaimType })
  @IsEnum(DisputeClaimType)
  claimType: DisputeClaimType;

  @ApiProperty({
    description: 'Anything to add. Optional in the UI, required to be non-empty here.',
  })
  @IsString()
  @Length(1, 2048)
  reason: string;

  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description: 'Ids of the calls the provider selected as supporting the claim',
  })
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  selectedCallIds: string[] = [];
}

export class SlashProposalTimelineDto {
  @ApiProperty({ type: [SlashProposalEventDto] })
  events: SlashProposalEventDto[];

  @ApiProperty({ type: [RestorationRowDto] })
  restoration: RestorationRowDto[];
}

/**
 * The provider's own view of a penalty proposed against them: the case
 * screen, the dispute filing form and the dispute case state.
 *
 * Organization-scoped in the ordinary way — a proposal belongs to the provider
 * whose stake it threatens, so `session.organizationId` is the query's own
 * tenant. The operator's cross-tenant queue is a separate controller behind a
 * separate guard, and the two never share a route.
 */
@ApiTags('Provider')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('providers/me/slash-proposals')
export class ProviderSlashProposalsController {
  constructor(
    private readonly cases: SlashCaseService,
    private readonly lifecycle: SlashProposalService,
    private readonly arbitration: ArbitrationService,
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

  @Get(':proposalId/timeline')
  @ApiOperation({ summary: 'The case timeline and the restoration record' })
  @ApiResponse({ status: 200, type: SlashProposalTimelineDto })
  async getTimeline(
    @CurrentSession() session: McpSession,
    @Param() params: SlashProposalIdParamsDto,
  ): Promise<SlashProposalTimelineDto> {
    const [events, restoration] = await Promise.all([
      this.cases.timeline(session.organizationId, params.proposalId),
      this.cases.restoration(session.organizationId, params.proposalId),
    ]);
    return { events, restoration };
  }

  /**
   * Opening the case.
   *
   * Recorded, and it moves no clock. The provider's window runs from
   * *delivery*, not from reading — a provider who never opens the dashboard has
   * exactly as long to object as one who opens it immediately.
   *
   * Allowed while blocked, like the objection below: it records a reading and
   * grants nothing.
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

  /**
   * File the objection.
   *
   * Filing is free and does not affect routing or tier — stated on the screen,
   * and true: nothing in this path touches either. It is worth saying out loud
   * because the fear that disputing will cost them traffic is the reason
   * providers in every comparable system under-dispute.
   *
   * Allowed while blocked (review S-8): an objection only takes authority
   * away from the platform, and without it a blocked provider's open cases
   * would auto-uphold when the response window closes.
   */
  @Post(':proposalId/dispute')
  @UseGuards(HumanSessionGuard)
  @AllowedWhileBlocked()
  @ApiOperation({ summary: 'Object to a proposed penalty' })
  @ApiResponse({ status: 201, type: SlashProposalCaseDto })
  @ApiResponse({ status: 409, description: 'The window to object has closed, or one is on file' })
  async dispute(
    @CurrentSession() session: McpSession,
    @Param() params: SlashProposalIdParamsDto,
    @Body() body: FileSlashDisputeBodyDto,
  ): Promise<SlashProposalCaseDto> {
    await this.arbitration.fileDispute(session.organizationId, params.proposalId, {
      claimType: body.claimType,
      reason: body.reason,
      evidence: body.selectedCallIds,
      openedBy: session.agentId,
    });
    return this.cases.buildCase(session.organizationId, params.proposalId);
  }
}
