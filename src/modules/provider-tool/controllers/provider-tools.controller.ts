import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { auditActorOf } from '@shared/audit';
import { CurrentSession, HumanSessionGuard, SessionAuthGuard } from '@shared/auth';

import {
  CreateProviderToolBodyDto,
  DeprecateProviderToolMajorBodyDto,
  InvitationParamDto,
  ListProviderToolsQueryDto,
  PromotionInvitationListDto,
  ProviderToolContractBodyDto,
  ProviderToolDto,
  ProviderToolGateDto,
  ProviderToolIdParamDto,
  ProviderToolSummaryDto,
  ProviderToolTopicsDto,
  ProviderToolVersionParamDto,
  ProviderToolTryResultDto,
  SetReplacementBodyDto,
  ShareProviderToolBodyDto,
  TryProviderToolBodyDto,
  UpdateProviderToolBodyDto,
} from '../dto/provider-tools.dto';
import { ProviderToolTryService } from '../services/provider-tool-try.service';
import { ProviderToolsService } from '../services/provider-tools.service';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';
import { BumpsOperatorConsole } from '@shared/decorators/tenant-write.decorator';

/**
 * "Publish your own API" (design spec §7.6, §7.9 Provider, §7.10): a
 * provider's own tools, `{handle}__{tool}`.
 *
 * Person-only, reads included, like the binding editor: a provider tool's
 * text reaches every model that lists it, and its review is a promise made
 * by a person. Literal segments (`try`, `topics`, `invitations`) are declared before `:id`.
 * Another organization's tool is the same 404 as one that does not exist.
 */
@ApiTags('Provider')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard, HumanSessionGuard)
// Writes here appear in the operator console's work lists.
@BumpsOperatorConsole()
@Controller('provider/tools')
export class ProviderToolsController {
  constructor(
    private readonly tools: ProviderToolsService,
    private readonly trial: ProviderToolTryService,
  ) {}

  @Get()
  @TenantCache({ ttl: 15, vary: 'org', epochs: ['provider', 'shared'] })
  @ApiOperation({ summary: 'Your provider tools, newest first, with their review state' })
  @ApiCursorPage(ProviderToolSummaryDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListProviderToolsQueryDto,
  ): Promise<CursorPageDto<ProviderToolSummaryDto>> {
    return this.tools.list(session.organizationId, query);
  }

  @Post()
  @ApiOperation({
    summary:
      'Create a provider tool `{handle}__{tool}`: PRIVATE, with a DRAFT 1.0.0 of your contract',
  })
  @ApiResponse({ status: 201, type: ProviderToolDto })
  @ApiResponse({
    status: 400,
    description: 'TOOL_PROVIDER_TOOL_INVALID: name caps, contract, rules',
  })
  @ApiResponse({
    status: 403,
    description: 'TOOL_PROVIDER_TOOL_NOT_ALLOWED: no provider account or handle',
  })
  @ApiResponse({ status: 409, description: 'TOOL_PROVIDER_TOOL_NAME_TAKEN, with a `suggestion`' })
  async create(
    @CurrentSession() session: McpSession,
    @Body() body: CreateProviderToolBodyDto,
  ): Promise<ProviderToolDto> {
    return this.tools.create(session.organizationId, body, auditActorOf(session));
  }

  @Post('try')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Try your endpoint: one real call from a curl command or an OpenAPI operation, through ' +
      'the egress relay and request signing, and the inferred schemas, example and mapping. ' +
      'Stores nothing',
  })
  @ApiResponse({ status: 200, type: ProviderToolTryResultDto })
  @ApiResponse({
    status: 400,
    description: 'TOOL_PROVIDER_TOOL_INVALID: unparseable, unsupported, or a private address',
  })
  @ApiResponse({ status: 403, description: 'TOOL_PROVIDER_TOOL_NOT_ALLOWED: no provider account' })
  @ApiResponse({ status: 429, description: 'PROVIDER_EGRESS_RATE_LIMITED' })
  async tryEndpoint(
    @CurrentSession() session: McpSession,
    @Body() body: TryProviderToolBodyDto,
  ): Promise<ProviderToolTryResultDto> {
    return this.trial.try(session, body);
  }

  @Get('topics')
  @ApiOperation({
    summary:
      'The topics (categories) a provider tool may take: a fixed list ending in "other", then ' +
      'any category already in use',
  })
  @ApiResponse({ status: 200, type: ProviderToolTopicsDto })
  async topics(): Promise<ProviderToolTopicsDto> {
    return this.tools.topics();
  }

  @Get('invitations')
  @TenantCache({ ttl: 15, vary: 'org', epochs: ['provider', 'shared'] })
  @ApiOperation({
    summary:
      'Promotion invitations: standard contracts drafted from your tools, with a binding ' +
      'prefill taken from your provider tool’s mapping',
  })
  @ApiResponse({ status: 200, type: PromotionInvitationListDto })
  async invitations(@CurrentSession() session: McpSession): Promise<PromotionInvitationListDto> {
    return this.tools.invitations(session.organizationId);
  }

  @Post('invitations/:standardToolId/:sourceToolId/dismiss')
  @HttpCode(204)
  @ApiOperation({ summary: 'Dismiss a promotion invitation' })
  async dismissInvitation(
    @CurrentSession() session: McpSession,
    @Param() params: InvitationParamDto,
  ): Promise<void> {
    await this.tools.dismissInvitation(
      session.organizationId,
      params.standardToolId,
      params.sourceToolId,
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One provider tool: versions, draft with its screen, binding, review state, quality',
  })
  @ApiResponse({ status: 200, type: ProviderToolDto })
  @ApiResponse({ status: 404, description: 'TOOL_PROVIDER_TOOL_NOT_FOUND' })
  async get(
    @CurrentSession() session: McpSession,
    @Param() params: ProviderToolIdParamDto,
  ): Promise<ProviderToolDto> {
    return this.tools.get(session.organizationId, params.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change the category or tags' })
  @ApiResponse({ status: 200, type: ProviderToolDto })
  async update(
    @CurrentSession() session: McpSession,
    @Param() params: ProviderToolIdParamDto,
    @Body() body: UpdateProviderToolBodyDto,
  ): Promise<ProviderToolDto> {
    return this.tools.update(session.organizationId, params.id, body, auditActorOf(session));
  }

  @Get(':id/publish-check')
  @ApiOperation({
    summary:
      'The publish gate: binding test run, stake, payout, and the schema screen of every ' +
      'version the tool would serve',
  })
  @ApiResponse({ status: 200, type: ProviderToolGateDto })
  async publishCheck(
    @CurrentSession() session: McpSession,
    @Param() params: ProviderToolIdParamDto,
  ): Promise<ProviderToolGateDto> {
    return this.tools.publishCheck(session.organizationId, params.id);
  }

  @Post(':id/versions')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Save the draft version (create or replace); the semver follows the schema diff ' +
      '(patch, minor, major)',
  })
  @ApiResponse({ status: 200, type: ProviderToolDto })
  @ApiResponse({ status: 409, description: 'TOOL_PROVIDER_TOOL_IN_REVIEW: the draft is frozen' })
  async saveDraft(
    @CurrentSession() session: McpSession,
    @Param() params: ProviderToolIdParamDto,
    @Body() body: ProviderToolContractBodyDto,
  ): Promise<ProviderToolDto> {
    return this.tools.saveDraft(session.organizationId, params.id, body, auditActorOf(session));
  }

  @Delete(':id/versions/draft')
  @ApiOperation({ summary: 'Discard the draft version' })
  @ApiResponse({ status: 200, type: ProviderToolDto })
  async discardDraft(
    @CurrentSession() session: McpSession,
    @Param() params: ProviderToolIdParamDto,
  ): Promise<ProviderToolDto> {
    return this.tools.discardDraft(session.organizationId, params.id, auditActorOf(session));
  }

  @Post(':id/versions/:version/publish')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Publish the draft. PRIVATE: at once. UNLISTED: through the publish gate. LISTED: it ' +
      'goes to review, and the approved version keeps serving until it is approved',
  })
  @ApiResponse({ status: 200, type: ProviderToolDto })
  @ApiResponse({
    status: 409,
    description: 'TOOL_PROVIDER_TOOL_GATE_FAILED, TOOL_PROVIDER_TOOL_IN_REVIEW',
  })
  async publishVersion(
    @CurrentSession() session: McpSession,
    @Param() params: ProviderToolVersionParamDto,
  ): Promise<ProviderToolDto> {
    return this.tools.publishVersion(
      session.organizationId,
      params.id,
      Number(params.version),
      auditActorOf(session),
    );
  }

  @Post(':id/versions/:version/deprecate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Deprecate a major other than the current one (sunset ≥ 90 days)' })
  @ApiResponse({ status: 200, type: ProviderToolDto })
  async deprecate(
    @CurrentSession() session: McpSession,
    @Param() params: ProviderToolVersionParamDto,
    @Body() body: DeprecateProviderToolMajorBodyDto,
  ): Promise<ProviderToolDto> {
    return this.tools.deprecateMajor(
      session.organizationId,
      params.id,
      Number(params.version),
      body.sunsetAt,
      auditActorOf(session),
      body.replacementToolId ?? null,
    );
  }

  @Post(':id/publish')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Share as UNLISTED ("Anyone with the link", badge "Not reviewed"), through the publish ' +
      'gate; locks your public name',
  })
  @ApiResponse({ status: 200, type: ProviderToolDto })
  @ApiResponse({ status: 409, description: 'TOOL_PROVIDER_TOOL_GATE_FAILED' })
  async share(
    @CurrentSession() session: McpSession,
    @Param() params: ProviderToolIdParamDto,
    @Body() _body: ShareProviderToolBodyDto,
  ): Promise<ProviderToolDto> {
    return this.tools.shareUnlisted(session.organizationId, params.id, auditActorOf(session));
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Stop sharing: UNLISTED back to PRIVATE ("Only my team"). Link-only tool sets stop ' +
      'reaching it at once; your own /my/ URLs keep serving it',
  })
  @ApiResponse({ status: 200, type: ProviderToolDto })
  @ApiResponse({
    status: 409,
    description: 'TOOL_PROVIDER_TOOL_STATE (not UNLISTED), TOOL_PROVIDER_TOOL_IN_REVIEW',
  })
  async unshare(
    @CurrentSession() session: McpSession,
    @Param() params: ProviderToolIdParamDto,
  ): Promise<ProviderToolDto> {
    return this.tools.unshare(session.organizationId, params.id, auditActorOf(session));
  }

  @Post(':id/review')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Submit for review (LISTED): every version the tool serves, or a listed tool’s draft. ' +
      'Through the publish gate; PENDING until an operator decides',
  })
  @ApiResponse({ status: 200, type: ProviderToolDto })
  @ApiResponse({
    status: 409,
    description: 'TOOL_PROVIDER_TOOL_GATE_FAILED, TOOL_PROVIDER_TOOL_IN_REVIEW',
  })
  async submitReview(
    @CurrentSession() session: McpSession,
    @Param() params: ProviderToolIdParamDto,
  ): Promise<ProviderToolDto> {
    return this.tools.submitReview(session.organizationId, params.id, auditActorOf(session));
  }

  @Post(':id/review/withdraw')
  @HttpCode(200)
  @ApiOperation({ summary: 'Withdraw a pending review' })
  @ApiResponse({ status: 200, type: ProviderToolDto })
  async withdrawReview(
    @CurrentSession() session: McpSession,
    @Param() params: ProviderToolIdParamDto,
  ): Promise<ProviderToolDto> {
    return this.tools.withdrawReview(session.organizationId, params.id, auditActorOf(session));
  }

  @Put(':id/replacement')
  @ApiOperation({
    summary: 'Point to the standard tool that replaces this one (after promotion), or clear it',
  })
  @ApiResponse({ status: 200, type: ProviderToolDto })
  async setReplacement(
    @CurrentSession() session: McpSession,
    @Param() params: ProviderToolIdParamDto,
    @Body() body: SetReplacementBodyDto,
  ): Promise<ProviderToolDto> {
    return this.tools.setReplacement(
      session.organizationId,
      params.id,
      body.replacementToolId,
      auditActorOf(session),
    );
  }
}
