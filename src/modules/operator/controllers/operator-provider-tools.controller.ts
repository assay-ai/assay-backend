import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  ReviewDetailDto,
  ReviewQueueItemDto,
} from '@modules/provider-tool/dto/provider-tool-review.dto';
import {
  DraftPromotionBodyDto,
  InvitePromotionBodyDto,
  PromotionGroupListDto,
  PromotionInviteListDto,
  ReviewDecisionBodyDto,
  SimilarToolListDto,
  StandardToolParamDto,
  ToolIdParamDto,
} from '@modules/provider-tool/dto/tool-promotion.dto';
import { RequestContext } from '@shared/observability';
import { CurrentOperator, OperatorAuthGuard, OperatorRolesGuard, RequireRoles } from '@shared/auth';

import { Override, OverrideExempt } from '../decorators/override.decorator';
import { OperatorRole } from '../domain/override-register';
import { ListModerationQueryDto } from '../dto/operator-moderation.dto';
import { OperatorOverrideGuard } from '../guards/operator-override.guard';
import { OperatorSession } from '../ports/operator-session.port';
import {
  OperatorProviderToolsService,
  ReviewDecisionResultDto,
} from '../services/operator-provider-tools.service';

const PROMOTION_EXEMPTION =
  'drafting a standard contract and inviting providers serve nothing: the contract reaches ' +
  'traffic only through the two-person publish (P-10)';

/**
 * Provider tool review and promotion (design spec §7.6, §7.5, §7.9
 * Operator). Same three guards, in the same order, as every operator
 * controller that writes; the decision cites its register row (`A-24`).
 * The takedown (`A-25`) is on the moderation controller beside the other
 * cutoffs, and confirmed or reverted like them.
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard, OperatorRolesGuard, OperatorOverrideGuard)
@Controller('operator')
export class OperatorProviderToolsController {
  constructor(private readonly tools: OperatorProviderToolsService) {}

  @Get('reviews')
  @ApiOperation({
    summary:
      'The provider tool review queue: pending first, oldest submission first; `pending=false` ' +
      'adds decided ones',
  })
  @ApiResponse({ status: 200, type: [ReviewQueueItemDto] })
  async queue(@Query() query: ListModerationQueryDto): Promise<ReviewQueueItemDto[]> {
    return this.tools.queue(query.pending !== false);
  }

  @Get('reviews/:id')
  @ApiOperation({
    summary:
      'One review: the content it covers and its hash, the diff of a change, the §7.6 ' +
      'checklist and the publish gate',
  })
  @ApiResponse({ status: 200, type: ReviewDetailDto })
  @ApiResponse({ status: 404, description: 'TOOL_PROVIDER_TOOL_NOT_FOUND' })
  async detail(@Param() params: ToolIdParamDto): Promise<ReviewDetailDto> {
    return this.tools.detail(params.id);
  }

  @Post('reviews/:id')
  @HttpCode(200)
  @Override('A-24')
  @RequireRoles(OperatorRole.ADJ, OperatorRole.ADJL, OperatorRole.POL)
  @ApiOperation({
    summary:
      'Approve (LISTED; a change is published) or reject with a note, for the content hash read',
  })
  @ApiResponse({ status: 200, description: '{ toolId, decision, kind, approvedVersion }' })
  @ApiResponse({ status: 409, description: 'TOOL_REVIEW_NOT_PENDING, TOOL_REVIEW_STALE' })
  async decide(
    @CurrentOperator() operator: OperatorSession,
    @Param() params: ToolIdParamDto,
    @Body() body: ReviewDecisionBodyDto,
  ): Promise<ReviewDecisionResultDto> {
    return this.tools.decide(operator, params.id, body, requestIdOf());
  }

  @Get('promotions')
  @ApiOperation({
    summary:
      'Groups of similar provider tools (same category, similar names and schemas): ' +
      'candidates for a standard contract',
  })
  @ApiResponse({ status: 200, type: PromotionGroupListDto })
  async groups(): Promise<PromotionGroupListDto> {
    return this.tools.groups();
  }

  @Get('promotions/similar/:id')
  @ApiOperation({ summary: 'The provider tools similar to one, most similar first' })
  @ApiResponse({ status: 200, type: SimilarToolListDto })
  async similar(@Param() params: ToolIdParamDto): Promise<SimilarToolListDto> {
    return this.tools.similar(params.id);
  }

  @Post('promotions')
  @HttpCode(201)
  @OverrideExempt(PROMOTION_EXEMPTION)
  @RequireRoles(OperatorRole.POL, OperatorRole.POLA)
  @ApiOperation({
    summary:
      'Draft a standard contract from a provider tool and invite its provider (and others); ' +
      'publish it with the contract editor',
  })
  @ApiResponse({ status: 201, description: '{ tool: OperatorToolDto, invites }' })
  @ApiResponse({ status: 400, description: 'TOOL_PROMOTION_INVALID' })
  @ApiResponse({ status: 409, description: 'TOOL_CONTRACT_NAME_TAKEN' })
  async draft(
    @CurrentOperator() operator: OperatorSession,
    @Body() body: DraftPromotionBodyDto,
  ): Promise<unknown> {
    return this.tools.draft(operator, body);
  }

  @Get('promotions/:standardToolId/invites')
  @ApiOperation({ summary: 'The providers invited to a standard tool, and whether each bound' })
  @ApiResponse({ status: 200, type: PromotionInviteListDto })
  async invites(@Param() params: StandardToolParamDto): Promise<PromotionInviteListDto> {
    return this.tools.invites(params.standardToolId);
  }

  @Post('promotions/:standardToolId/invites')
  @HttpCode(200)
  @OverrideExempt(PROMOTION_EXEMPTION)
  @RequireRoles(OperatorRole.POL, OperatorRole.POLA)
  @ApiOperation({ summary: 'Invite more providers to bind to a standard tool' })
  @ApiResponse({ status: 200, type: PromotionInviteListDto })
  async invite(
    @CurrentOperator() operator: OperatorSession,
    @Param() params: StandardToolParamDto,
    @Body() body: InvitePromotionBodyDto,
  ): Promise<PromotionInviteListDto> {
    return this.tools.invite(operator, params.standardToolId, body);
  }
}

/** The server-minted request id, never the caller's. */
function requestIdOf(): string | null {
  return RequestContext.getServerRequestId();
}
