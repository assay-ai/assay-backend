import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { CutoffAction } from '@modules/toolset/services/toolset-moderation.service';
import { RequestContext } from '@shared/observability';
import { CurrentOperator, OperatorAuthGuard, OperatorRolesGuard, RequireRoles } from '@shared/auth';

import { Override } from '../decorators/override.decorator';
import { OperatorRole } from '../domain/override-register';
import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import {
  HandleParamDto,
  ListCutoffsQueryDto,
  ListModerationQueryDto,
  ModerationBodyDto,
  ModerationCutoffDto,
  OperatorReportDto,
  ReassignHandleBodyDto,
  RenameHandleBodyDto,
  ResolveReportBodyDto,
  TakedownToolBodyDto,
} from '../dto/operator-moderation.dto';
import { OperatorOverrideGuard } from '../guards/operator-override.guard';
import { OperatorSession } from '../ports/operator-session.port';
import { OperatorModerationService } from '../services/operator-moderation.service';
import { answerOrQueued } from './approval-response';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

/**
 * Toolset and public-name moderation (design spec §7.9 "Operator", FR-15,
 * FR-18). Same three guards, in the same order, as every operator controller
 * that writes; every mutating route cites its register row.
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard, OperatorRolesGuard, OperatorOverrideGuard)
@Controller('operator')
export class OperatorModerationController {
  constructor(private readonly moderation: OperatorModerationService) {}

  @Post('toolsets/:id/delist')
  @HttpCode(200)
  @Override('A-15')
  @RequireRoles(
    OperatorRole.ADJ,
    OperatorRole.ADJL,
    OperatorRole.SRE,
    OperatorRole.POL,
    OperatorRole.POLA,
  )
  @ApiOperation({
    summary: 'Delist a public tool set at once; a second operator confirms within 72 h',
  })
  @ApiResponse({ status: 200, type: ModerationCutoffDto })
  async delist(
    @CurrentOperator() operator: OperatorSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ModerationBodyDto,
  ): Promise<ModerationCutoffDto> {
    return this.moderation.cutoffToolset(operator, id, CutoffAction.DELIST, body, requestIdOf());
  }

  @Post('toolsets/:id/takedown')
  @HttpCode(200)
  @Override('A-16')
  @RequireRoles(OperatorRole.ADJ, OperatorRole.ADJL, OperatorRole.SRE)
  @ApiOperation({
    summary: 'Take a tool set down at once (only /my/ serves); confirmed within 72 h',
  })
  @ApiResponse({ status: 200, type: ModerationCutoffDto })
  async takedown(
    @CurrentOperator() operator: OperatorSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ModerationBodyDto,
  ): Promise<ModerationCutoffDto> {
    return this.moderation.cutoffToolset(operator, id, CutoffAction.TAKEDOWN, body, requestIdOf());
  }

  @Post('tools/:id/takedown')
  @HttpCode(200)
  @Override('A-25')
  @RequireRoles(OperatorRole.ADJ, OperatorRole.ADJL, OperatorRole.SRE)
  @ApiOperation({
    summary:
      'Take a provider tool down at once: removed from every view, calls get TOOL_REMOVED; ' +
      'a second operator confirms within 72 h',
  })
  @ApiResponse({ status: 200, type: ModerationCutoffDto })
  async takedownTool(
    @CurrentOperator() operator: OperatorSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TakedownToolBodyDto,
  ): Promise<ModerationCutoffDto> {
    return this.moderation.takedownTool(operator, id, body, requestIdOf());
  }

  @Post('toolsets/:id/relist')
  @HttpCode(204)
  @Override('A-20')
  @RequireRoles(OperatorRole.ADJ, OperatorRole.ADJL, OperatorRole.POL, OperatorRole.POLA)
  @ApiOperation({ summary: 'Relist a delisted tool set its owner fixed' })
  async relist(
    @CurrentOperator() operator: OperatorSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ModerationBodyDto,
  ): Promise<void> {
    await this.moderation.relistToolset(operator, id, body, requestIdOf());
  }

  @Post('handles/:handle/takedown')
  @HttpCode(200)
  @Override('A-17')
  @RequireRoles(OperatorRole.ADJ, OperatorRole.ADJL, OperatorRole.SRE)
  @ApiOperation({
    summary: 'Freeze a public name at once: every URL under it stops, no alias; confirmed in 72 h',
  })
  @ApiResponse({ status: 200, type: ModerationCutoffDto })
  async takedownHandle(
    @CurrentOperator() operator: OperatorSession,
    @Param() params: HandleParamDto,
    @Body() body: ModerationBodyDto,
  ): Promise<ModerationCutoffDto> {
    return this.moderation.takedownHandle(operator, params.handle, body, requestIdOf());
  }

  @Post('handles/:handle/rename')
  @HttpCode(200)
  @Override('A-21')
  @RequireRoles(OperatorRole.ADJ, OperatorRole.ADJL, OperatorRole.SUP)
  @ApiOperation({
    summary: 'Rename a locked public name (two-person); the old one is an alias for 90 days',
  })
  @ApiResponse({
    status: 202,
    type: ApprovalQueuedDto,
    description: 'Queued for a second operator',
  })
  @ApiResponse({
    status: 404,
    description: 'No such handle (TOOLSET_HANDLE_NOT_FOUND); nothing is queued',
  })
  async renameHandle(
    @CurrentOperator() operator: OperatorSession,
    @Param() params: HandleParamDto,
    @Body() body: RenameHandleBodyDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    return answerOrQueued(
      response,
      await this.moderation.renameHandle(operator, params.handle, body, requestIdOf()),
    );
  }

  @Post('handles/:handle/reassign')
  @HttpCode(200)
  @Override('A-22')
  @RequireRoles(OperatorRole.ADJL, OperatorRole.CMP)
  @ApiOperation({
    summary: 'Reassign a taken-down public name to a verified organization (two-person)',
  })
  @ApiResponse({
    status: 202,
    type: ApprovalQueuedDto,
    description: 'Queued for a second operator',
  })
  @ApiResponse({
    status: 404,
    description:
      'No such handle (TOOLSET_HANDLE_NOT_FOUND) or organization (TOOLSET_ORGANIZATION_NOT_FOUND); nothing is queued',
  })
  async reassignHandle(
    @CurrentOperator() operator: OperatorSession,
    @Param() params: HandleParamDto,
    @Body() body: ReassignHandleBodyDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    return answerOrQueued(
      response,
      await this.moderation.reassignHandle(operator, params.handle, body, requestIdOf()),
    );
  }

  @Get('cutoffs')
  @TenantCache({ ttl: 30, vary: 'operator', epochs: ['operator', 'shared'] })
  @ApiOperation({
    summary:
      'Delists and takedowns, newest first, with each target’s name; `pending` = still to ' +
      'confirm, `targetType` = TOOLSET, HANDLE or TOOL only',
  })
  @ApiResponse({ status: 200, type: [ModerationCutoffDto] })
  async cutoffs(@Query() query: ListCutoffsQueryDto): Promise<ModerationCutoffDto[]> {
    return this.moderation.listCutoffs(query);
  }

  @Post('cutoffs/:id/confirm')
  @HttpCode(200)
  @Override('A-18')
  @RequireRoles(OperatorRole.ADJ, OperatorRole.ADJL)
  @ApiOperation({ summary: 'Confirm another operator’s delist or takedown' })
  @ApiResponse({ status: 200, type: ModerationCutoffDto })
  @ApiResponse({
    status: 409,
    description: 'TOOLSET_CUTOFF_SELF_CONFIRM, TOOLSET_CUTOFF_NOT_PENDING',
  })
  async confirm(
    @CurrentOperator() operator: OperatorSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ModerationBodyDto,
  ): Promise<ModerationCutoffDto> {
    return this.moderation.confirmCutoff(operator, id, body, requestIdOf());
  }

  @Post('cutoffs/:id/revert')
  @HttpCode(200)
  @Override('A-19')
  @RequireRoles(OperatorRole.ADJ, OperatorRole.ADJL)
  @ApiOperation({
    summary: 'Reject a pending delist or takedown, or lift a confirmed one (two-person)',
  })
  @ApiResponse({ status: 200, type: ModerationCutoffDto })
  @ApiResponse({
    status: 202,
    type: ApprovalQueuedDto,
    description: 'Lifting a confirmed one: queued',
  })
  async revert(
    @CurrentOperator() operator: OperatorSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ModerationBodyDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    return answerOrQueued(
      response,
      await this.moderation.revertCutoff(operator, id, body, requestIdOf()),
    );
  }

  @Get('reports')
  @TenantCache({ ttl: 30, vary: 'operator', epochs: ['operator'] })
  @ApiOperation({ summary: 'Reports, newest first; `pending` = open only' })
  @ApiResponse({ status: 200, type: [OperatorReportDto] })
  async reports(@Query() query: ListModerationQueryDto): Promise<OperatorReportDto[]> {
    return this.moderation.listReports(query);
  }

  @Post('reports/:id')
  @HttpCode(200)
  @Override('A-23')
  @RequireRoles(OperatorRole.ADJ, OperatorRole.ADJL, OperatorRole.SUP)
  @ApiOperation({ summary: 'Resolve a report' })
  @ApiResponse({ status: 200, type: OperatorReportDto })
  async resolveReport(
    @CurrentOperator() operator: OperatorSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ResolveReportBodyDto,
  ): Promise<OperatorReportDto> {
    return this.moderation.resolveReport(operator, id, body, requestIdOf());
  }
}

/** The server-minted request id, never the caller's. */
function requestIdOf(): string | null {
  return RequestContext.getServerRequestId();
}
