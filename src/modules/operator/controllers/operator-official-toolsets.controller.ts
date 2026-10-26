import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
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
  CreateOfficialToolsetBodyDto,
  OperatorOfficialToolsetDto,
  OperatorOfficialToolsetListDto,
  PublishOfficialToolsetBodyDto,
  UpdateOfficialToolsetBodyDto,
} from '../dto/operator-official-toolsets.dto';
import { OperatorOverrideGuard } from '../guards/operator-override.guard';
import { OperatorSession } from '../ports/operator-session.port';
import { OperatorOfficialToolsetsService } from '../services/operator-official-toolsets.service';
import { answerOrQueued } from './approval-response';

const DRAFT_EXEMPTION =
  'drafting an official tool set serves nothing: only publishing (P-13) reaches buyers, and it is two-person';

/**
 * Official tool sets, `/@assay/{slug}` (design spec §7.10). Same three
 * guards, in the same order, as every operator controller that writes.
 * Drafting is exempt from the register because nothing serves a Draft;
 * publishing cites P-13. Delist and relist are `POST /operator/toolsets/:id/
 * delist` (A-15) and `/relist` (A-20).
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard, OperatorRolesGuard, OperatorOverrideGuard)
@Controller('operator/toolsets/official')
export class OperatorOfficialToolsetsController {
  constructor(private readonly official: OperatorOfficialToolsetsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Every official tool set, Drafts and delisted ones included; each tool with its ACTIVE ' +
      'binding count',
  })
  @ApiResponse({ status: 200, type: OperatorOfficialToolsetListDto })
  async list(): Promise<OperatorOfficialToolsetListDto> {
    return this.official.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'One official tool set, its Draft and any publish awaiting approval' })
  @ApiResponse({ status: 200, type: OperatorOfficialToolsetDto })
  @ApiResponse({ status: 404, description: 'TOOLSET_NOT_FOUND' })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<OperatorOfficialToolsetDto> {
    return this.official.get(id);
  }

  @Post()
  @HttpCode(201)
  @OverrideExempt(DRAFT_EXEMPTION)
  @RequireRoles(OperatorRole.POL, OperatorRole.POLA)
  @ApiOperation({ summary: 'Create the Draft of an official tool set (serves nothing yet)' })
  @ApiResponse({ status: 201, type: OperatorOfficialToolsetDto })
  @ApiResponse({ status: 400, description: 'TOOLSET_INVALID: a tool not LISTED and ACTIVE, …' })
  @ApiResponse({ status: 409, description: 'TOOLSET_SLUG_TAKEN, with a free suggestion' })
  async create(
    @CurrentOperator() operator: OperatorSession,
    @Body() body: CreateOfficialToolsetBodyDto,
  ): Promise<OperatorOfficialToolsetDto> {
    return this.official.create(operator, body);
  }

  @Patch(':id')
  @HttpCode(200)
  @OverrideExempt(DRAFT_EXEMPTION)
  @RequireRoles(OperatorRole.POL, OperatorRole.POLA)
  @ApiOperation({
    summary:
      'Edit the Draft. Category and tags change the live set at once; everything else waits ' +
      'for the next publish',
  })
  @ApiResponse({ status: 200, type: OperatorOfficialToolsetDto })
  @ApiResponse({
    status: 409,
    description:
      'TOOLSET_SLUG_LOCKED, TOOLSET_SLUG_TAKEN, TOOLSET_STATE (a publish awaits approval)',
  })
  async update(
    @CurrentOperator() operator: OperatorSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateOfficialToolsetBodyDto,
  ): Promise<OperatorOfficialToolsetDto> {
    return this.official.update(operator, id, body);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @Override('P-13')
  @RequireRoles(OperatorRole.POL, OperatorRole.POLA)
  @ApiOperation({
    summary:
      'Publish the Draft as the next version, listed at /@assay/{slug} (two-person: a POLA ' +
      'approves exactly the Draft that was requested)',
  })
  @ApiResponse({ status: 200, type: OperatorOfficialToolsetDto })
  @ApiResponse({
    status: 202,
    type: ApprovalQueuedDto,
    description: 'Queued for a second operator',
  })
  @ApiResponse({ status: 400, description: 'TOOLSET_NOT_PUBLISHABLE; nothing is queued' })
  @ApiResponse({
    status: 409,
    description: 'TOOLSET_STATE (nothing changed, or the Draft changed since the request)',
  })
  async publish(
    @CurrentOperator() operator: OperatorSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PublishOfficialToolsetBodyDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    return answerOrQueued(
      response,
      await this.official.publish(operator, id, body, RequestContext.getServerRequestId()),
    );
  }
}
