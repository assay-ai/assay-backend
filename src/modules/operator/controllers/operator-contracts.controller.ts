import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { RequestContext } from '@shared/observability';
import { CurrentOperator, OperatorAuthGuard, OperatorRolesGuard, RequireRoles } from '@shared/auth';

import { Override, OverrideExempt } from '../decorators/override.decorator';
import { OperatorRole } from '../domain/override-register';
import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import {
  ContractActionBodyDto,
  CreateStandardToolBodyDto,
  DeprecateVersionBodyDto,
  MoveCurrentVersionBodyDto,
  OperatorToolDto,
  OperatorToolListDto,
  SaveContractDraftBodyDto,
  ToolIdParamDto,
  ToolVersionParamDto,
} from '../dto/operator-contracts.dto';
import { OperatorOverrideGuard } from '../guards/operator-override.guard';
import { OperatorSession } from '../ports/operator-session.port';
import { OperatorContractsService } from '../services/operator-contracts.service';
import { answerOrQueued } from './approval-response';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

const DRAFT_EXEMPTION =
  'drafting a contract serves nothing: only publishing (P-10) reaches traffic, and it is two-person';

/**
 * The standard contract editor (design spec §7.5 "Editor", §7.9 Operator).
 * Same three guards, in the same order, as every operator controller that
 * writes. Drafting is exempt from the register because nothing serves a
 * draft; every action that reaches traffic cites its row.
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard, OperatorRolesGuard, OperatorOverrideGuard)
@Controller('operator/tools')
export class OperatorContractsController {
  constructor(private readonly contracts: OperatorContractsService) {}

  @Get()
  @TenantCache({ ttl: 30, vary: 'operator', epochs: ['operator', 'shared'], singleFlight: true })
  @ApiOperation({ summary: 'Every tool, drafts included, with its current version' })
  @ApiResponse({ status: 200, type: OperatorToolListDto })
  async list(): Promise<OperatorToolListDto> {
    return this.contracts.list();
  }

  @Post()
  @HttpCode(201)
  @OverrideExempt(DRAFT_EXEMPTION)
  @RequireRoles(OperatorRole.POL, OperatorRole.POLA)
  @ApiOperation({ summary: 'Create a DRAFT standard tool (no version yet; in no catalogue)' })
  @ApiResponse({ status: 201, type: OperatorToolDto })
  @ApiResponse({ status: 409, description: 'TOOL_CONTRACT_NAME_TAKEN, with a free suggestion' })
  async create(@Body() body: CreateStandardToolBodyDto): Promise<OperatorToolDto> {
    return this.contracts.createTool(body);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'A tool: published versions, the draft with its diff and computed bump, eligible ' +
      'bindings per major, and the suggested current version',
  })
  @ApiResponse({ status: 200, type: OperatorToolDto })
  async get(@Param() params: ToolIdParamDto): Promise<OperatorToolDto> {
    return this.contracts.get(params.id);
  }

  @Post(':id/versions')
  @HttpCode(200)
  @OverrideExempt(DRAFT_EXEMPTION)
  @RequireRoles(OperatorRole.POL, OperatorRole.POLA)
  @ApiOperation({
    summary:
      'Save the DRAFT version (creates it, or replaces it). The response carries the schema ' +
      'diff against its base and the bump: patch, minor (optional field added) or major',
  })
  @ApiResponse({ status: 200, type: OperatorToolDto })
  @ApiResponse({ status: 400, description: 'TOOL_CONTRACT_INVALID, with every problem' })
  async saveDraft(
    @CurrentOperator() operator: OperatorSession,
    @Param() params: ToolIdParamDto,
    @Body() body: SaveContractDraftBodyDto,
  ): Promise<OperatorToolDto> {
    return this.contracts.saveDraft(operator, params.id, body);
  }

  @Delete(':id/versions/draft')
  @HttpCode(200)
  @OverrideExempt(DRAFT_EXEMPTION)
  @RequireRoles(OperatorRole.POL, OperatorRole.POLA)
  @ApiOperation({ summary: 'Discard the DRAFT version' })
  @ApiResponse({ status: 200, type: OperatorToolDto })
  async discardDraft(
    @CurrentOperator() operator: OperatorSession,
    @Param() params: ToolIdParamDto,
  ): Promise<OperatorToolDto> {
    return this.contracts.discardDraft(operator, params.id);
  }

  @Post(':id/versions/:version/publish')
  @HttpCode(200)
  @Override('P-10')
  @RequireRoles(OperatorRole.POL, OperatorRole.POLA)
  @ApiOperation({
    summary:
      'Publish the draft (two-person). A patch or minor of the current major becomes ' +
      'current; a new major does not',
  })
  @ApiResponse({ status: 200, type: OperatorToolDto })
  @ApiResponse({
    status: 202,
    type: ApprovalQueuedDto,
    description: 'Queued for a second operator',
  })
  @ApiResponse({ status: 409, description: 'TOOL_CONTRACT_NO_CHANGES, TOOL_CONTRACT_STATE' })
  async publish(
    @CurrentOperator() operator: OperatorSession,
    @Param() params: ToolVersionParamDto,
    @Body() body: ContractActionBodyDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    return answerOrQueued(
      response,
      await this.contracts.publish(
        operator,
        params.id,
        Number(params.version),
        body,
        requestIdOf(),
      ),
    );
  }

  @Post(':id/current-version')
  @HttpCode(200)
  @Override('P-11')
  @RequireRoles(OperatorRole.POL, OperatorRole.POLA)
  @ApiOperation({
    summary: 'Move the version unpinned URLs serve (two-person), e.g. to a new major',
  })
  @ApiResponse({ status: 200, type: OperatorToolDto })
  @ApiResponse({
    status: 202,
    type: ApprovalQueuedDto,
    description: 'Queued for a second operator',
  })
  async moveCurrentVersion(
    @CurrentOperator() operator: OperatorSession,
    @Param() params: ToolIdParamDto,
    @Body() body: MoveCurrentVersionBodyDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    return answerOrQueued(
      response,
      await this.contracts.moveCurrentVersion(operator, params.id, body, requestIdOf()),
    );
  }

  @Post(':id/versions/:version/deprecate')
  @HttpCode(200)
  @Override('P-12')
  @RequireRoles(OperatorRole.POL, OperatorRole.POLA)
  @ApiOperation({
    summary:
      'Deprecate the major of this version: it runs until sunsetAt (at least 90 days), ' +
      'then retires; affected buyers and providers are notified',
  })
  @ApiResponse({ status: 200, type: OperatorToolDto })
  async deprecate(
    @CurrentOperator() operator: OperatorSession,
    @Param() params: ToolVersionParamDto,
    @Body() body: DeprecateVersionBodyDto,
  ): Promise<OperatorToolDto> {
    return this.contracts.deprecate(
      operator,
      params.id,
      Number(params.version),
      body,
      requestIdOf(),
    );
  }
}

function requestIdOf(): string | null {
  return RequestContext.getServerRequestId();
}
