import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { CurrentSession, HumanSessionGuard, SessionAuthGuard } from '@shared/auth';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { JsonObject } from '@modules/tool/domain/mapping/mapping.types';

import {
  GetToolBindingParamsDto,
  ListToolBindingsQueryDto,
  ToolBindingDetailDto,
  ToolBindingSummaryDto,
} from '../dto/get-tool-bindings.dto';
import { ToolCatalogueDto } from '../dto/get-tool-catalogue.dto';
import { PauseToolBindingBodyDto, PausedToolBindingDto } from '../dto/pause-tool-binding.dto';
import { PublishCheckDto, PublishedToolBindingDto } from '../dto/publish-tool-binding.dto';
import {
  SaveToolBindingBodyDto,
  SavedToolBindingDto,
  UpdateToolBindingBodyDto,
} from '../dto/save-tool-binding.dto';
import { BindingTestReportDto, RunBindingTestBodyDto } from '../dto/test-tool-binding.dto';
import { ValidateMappingBodyDto, ValidateMappingResponseDto } from '../dto/validate-mapping.dto';
import { BindingEditorService } from '../services/binding-editor.service';
import { BindingMappingTesterService } from '../services/binding-mapping-tester.service';
import { BindingPauseService } from '../services/binding-pause.service';
import { BindingPublishService } from '../services/binding-publish.service';
import { ProviderToolBindingsService } from '../services/provider-tool-bindings.service';

/**
 * The provider's own bindings — write, test, publish.
 *
 * The route order matters: `validate-mapping` and `catalogue` are declared
 * before `:id` so that the literal segment is not swallowed by the parameter.
 * Nest matches in declaration order, and a `POST
 * /tool-bindings/validate-mapping` resolving to "the binding with id
 * `validate-mapping`" is a 404 nobody can explain. `GET
 * /tool-bindings/catalogue` fails louder and no more helpfully — `400 id must
 * be a UUID`, from `GetToolBindingParamsDto`, about an id the caller never
 * sent.
 */
@ApiTags('Provider')
@ApiBearerAuth()
// Person-only, reads included (review A-1): a binding is where buyer requests
// go and what they cost. A machine credential that could re-point an endpoint
// and publish it would receive every call for that tool.
@UseGuards(SessionAuthGuard, HumanSessionGuard)
@Controller('providers/me/tool-bindings')
export class ProviderToolBindingsController {
  constructor(
    private readonly bindings: ProviderToolBindingsService,
    private readonly editor: BindingEditorService,
    private readonly tester: BindingMappingTesterService,
    private readonly publisher: BindingPublishService,
    private readonly pauser: BindingPauseService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The bindings this provider serves' })
  @ApiCursorPage(ToolBindingSummaryDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListToolBindingsQueryDto,
  ): Promise<CursorPageDto<ToolBindingSummaryDto>> {
    return this.bindings.listBindings(session.organizationId, query);
  }

  @Post()
  @ApiOperation({ summary: 'Create a binding. Always DRAFT — publishing is a separate step.' })
  @ApiResponse({ status: 201, type: SavedToolBindingDto })
  @ApiResponse({ status: 404, description: 'No tool in the catalogue with that id' })
  @ApiResponse({ status: 409, description: 'You already have a binding for that tool' })
  async create(
    @CurrentSession() session: McpSession,
    @Body() body: SaveToolBindingBodyDto,
  ): Promise<SavedToolBindingDto> {
    return this.editor.create(session.organizationId, subjectOf(session), body);
  }

  @Post('validate-mapping')
  @ApiOperation({
    summary: 'Check a mapping without saving it — what the editor calls while you type',
  })
  @ApiResponse({ status: 201, type: ValidateMappingResponseDto })
  @ApiResponse({ status: 400, description: 'TOOL_MAPPING_INVALID, with a pointer at the node' })
  async validateMapping(@Body() body: ValidateMappingBodyDto): Promise<ValidateMappingResponseDto> {
    return this.editor.validateMapping(body);
  }

  @Get('catalogue')
  @ApiOperation({
    summary:
      'The tools you can bind, with the contract each one has to satisfy, and the asset ' +
      'a binding is priced in: every listed standard tool, plus your own provider tools.',
  })
  @ApiResponse({ status: 200, type: ToolCatalogueDto })
  async catalogue(@CurrentSession() session: McpSession): Promise<ToolCatalogueDto> {
    // Standard tools are the same for every provider; a provider tool is
    // bindable by its own provider only (§7.6).
    return this.bindings.getCatalogue(session.organizationId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One binding, with its request/response mapping' })
  @ApiResponse({ status: 200, type: ToolBindingDetailDto })
  @ApiResponse({ status: 404, description: 'No binding of yours with this id' })
  async getOne(
    @CurrentSession() session: McpSession,
    @Param() params: GetToolBindingParamsDto,
  ): Promise<ToolBindingDetailDto> {
    return this.bindings.getBinding(session.organizationId, params.id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Edit a binding. A change to the mappings, endpoint, price or timeout raises the ' +
      'revision, which invalidates any green tester run against the old one.',
  })
  @ApiResponse({ status: 200, type: SavedToolBindingDto })
  @ApiResponse({ status: 409, description: 'The binding is SUSPENDED and cannot be edited' })
  async update(
    @CurrentSession() session: McpSession,
    @Param() params: GetToolBindingParamsDto,
    @Body() body: UpdateToolBindingBodyDto,
  ): Promise<SavedToolBindingDto> {
    return this.editor.update(session.organizationId, subjectOf(session), params.id, body);
  }

  @Post(':id/test')
  @ApiOperation({
    summary:
      'Call your endpoint for real, in a sandbox, and show what every production layer ' +
      'made of the answer. Charges nobody.',
  })
  @ApiResponse({ status: 201, type: BindingTestReportDto })
  async test(
    @CurrentSession() session: McpSession,
    @Param() params: GetToolBindingParamsDto,
    @Body() body: RunBindingTestBodyDto,
  ): Promise<BindingTestReportDto> {
    return this.tester.run(
      session.organizationId,
      subjectOf(session),
      params.id,
      body.input as JsonObject,
      body.toolVersion,
    );
  }

  @Get(':id/publish-check')
  @ApiOperation({
    summary:
      'Which publish conditions are met, and what is missing; the tester conditions one row ' +
      'per contract major in the range (`major`)',
  })
  @ApiResponse({ status: 200, type: PublishCheckDto })
  async publishCheck(
    @CurrentSession() session: McpSession,
    @Param() params: GetToolBindingParamsDto,
  ): Promise<PublishCheckDto> {
    return this.publisher.check(session.organizationId, params.id);
  }

  @Post(':id/pause')
  @ApiOperation({
    summary:
      'Stop this binding taking traffic, from the next call. No penalty, no effect on ' +
      'earnings already accrued, and no mark in your quality profile.',
  })
  @ApiResponse({ status: 201, type: PausedToolBindingDto })
  @ApiResponse({ status: 409, description: 'PROVIDER_BINDING_NOT_PAUSABLE — it is not serving' })
  async pause(
    @CurrentSession() session: McpSession,
    @Param() params: GetToolBindingParamsDto,
    @Body() body: PauseToolBindingBodyDto,
  ): Promise<PausedToolBindingDto> {
    return this.pauser.pause(session.organizationId, params.id, body);
  }

  @Post(':id/resume')
  @ApiOperation({
    summary: 'Take traffic again, at the revision that was already live. Not a republish.',
  })
  @ApiResponse({ status: 201, type: PausedToolBindingDto })
  @ApiResponse({
    status: 409,
    description:
      'PROVIDER_BINDING_NOT_PAUSED — nothing to resume; or ' +
      'PROVIDER_BINDING_NEVER_PUBLISHED — publish it instead',
  })
  async resume(
    @CurrentSession() session: McpSession,
    @Param() params: GetToolBindingParamsDto,
  ): Promise<PausedToolBindingDto> {
    return this.pauser.resume(session.organizationId, params.id);
  }

  @Post(':id/publish')
  @ApiOperation({ summary: 'Put the current revision live. Refused unless every check passes.' })
  @ApiResponse({ status: 201, type: PublishedToolBindingDto })
  @ApiResponse({ status: 409, description: 'PROVIDER_PUBLISH_CHECKS_FAILED, listing what failed' })
  async publish(
    @CurrentSession() session: McpSession,
    @Param() params: GetToolBindingParamsDto,
  ): Promise<PublishedToolBindingDto> {
    return this.publisher.publish(session.organizationId, subjectOf(session), params.id);
  }
}

/**
 * Who did it — the console credential, not the organization.
 *
 * `authored_by` and `published_by` are there to answer "who put this live",
 * and an organization id answers "which company", which is the question the
 * row already carries in `organization_id`.
 */
function subjectOf(session: McpSession): string {
  return session.credentialId;
}
