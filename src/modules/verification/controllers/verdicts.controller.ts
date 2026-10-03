import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';
import { ApiCursorPage, CursorPageDto } from '@shared/api';

import { VerdictEvidenceDto } from '../dto/get-verdict-evidence.dto';
import { GetVerdictParamsDto, VerdictDetailDto } from '../dto/get-verdict.dto';
import { ListVerdictsQueryDto, VerdictListItemDto } from '../dto/list-verdicts.dto';
import { VerdictService } from '../services/verdict.service';

/**
 * `GET /api/v1/verdicts`, `GET /api/v1/verdicts/:id`,
 * `GET /api/v1/verdicts/:id/evidence` — the verdict feed, one
 * verdict in full, and its evidence pack.
 *
 * `organizationId` comes from `@CurrentSession()` and nowhere else — see
 * `SessionAuthGuard`. `evidence` is nested under `:id` so it inherits the
 * same 404 rather than needing a second lookup path.
 */
@ApiTags('Verdicts')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('verdicts')
export class VerdictsController {
  constructor(private readonly verdicts: VerdictService) {}

  @Get()
  @ApiOperation({ summary: 'The verdict feed, newest first' })
  @ApiCursorPage(VerdictListItemDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListVerdictsQueryDto,
  ): Promise<CursorPageDto<VerdictListItemDto>> {
    return this.verdicts.list(session.organizationId, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One verdict in full — stage results, verifier votes, tally and policy version',
  })
  @ApiResponse({ status: 200, description: 'The verdict', type: VerdictDetailDto })
  @ApiResponse({ status: 404, description: 'No such verdict in this organization' })
  async getById(
    @CurrentSession() session: McpSession,
    @Param() params: GetVerdictParamsDto,
  ): Promise<VerdictDetailDto> {
    return this.verdicts.getById(session.organizationId, params);
  }

  @Get(':id/evidence')
  @ApiOperation({
    summary:
      'The evidence pack for one call — request, response, stage results, the sampling proof ' +
      'and the pinned policy document. Retrievable for any verdict, not only failures',
  })
  @ApiResponse({ status: 200, description: 'The evidence pack', type: VerdictEvidenceDto })
  @ApiResponse({ status: 404, description: 'No such verdict in this organization' })
  async getEvidence(
    @CurrentSession() session: McpSession,
    @Param() params: GetVerdictParamsDto,
  ): Promise<VerdictEvidenceDto> {
    return this.verdicts.getEvidence(session.organizationId, params);
  }
}
