import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { auditActorOf } from '@shared/audit';
import { CurrentSession, HumanSessionGuard, SessionAuthGuard } from '@shared/auth';

import { ClaimHandleBodyDto, OrgHandleDto } from '../dto/handle.dto';
import { HandlesService, OrgHandleView } from '../services/handles.service';

/** `/org/handle` — the organization's public name (design spec §7.1). */
@ApiTags('Toolsets')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('org/handle')
export class HandlesController {
  constructor(private readonly handles: HandlesService) {}

  @Get()
  @ApiOperation({ summary: "The organization's public name" })
  @ApiResponse({ status: 200, type: OrgHandleDto })
  async get(@CurrentSession() session: McpSession): Promise<OrgHandleDto> {
    return toDto(await this.handles.get(session.organizationId));
  }

  @Put()
  @UseGuards(HumanSessionGuard)
  @ApiOperation({
    summary: 'Claim or change the public name (before the first shared tool set locks it)',
    description:
      'Needs a verified organization (funded once, or a verified provider) and at most 3 ' +
      'organizations per person in 30 days. Unique ignoring case; reserved words and category ' +
      'names are refused.',
  })
  @ApiResponse({ status: 200, type: OrgHandleDto })
  @ApiResponse({ status: 400, description: 'TOOLSET_HANDLE_INVALID (`reason`: FORMAT | RESERVED)' })
  @ApiResponse({
    status: 403,
    description: 'TOOLSET_HANDLE_CLAIM_REFUSED (NOT_VERIFIED | CLAIM_LIMIT)',
  })
  @ApiResponse({
    status: 409,
    description: 'TOOLSET_HANDLE_TAKEN (`suggestions`), TOOLSET_HANDLE_LOCKED',
  })
  async claim(
    @CurrentSession() session: McpSession,
    @Body() body: ClaimHandleBodyDto,
  ): Promise<OrgHandleDto> {
    return toDto(await this.handles.claim(session, body.handle, auditActorOf(session)));
  }
}

function toDto(view: OrgHandleView): OrgHandleDto {
  return {
    handle: view.handle,
    status: view.status,
    lockedAt: view.lockedAt ? new Date(view.lockedAt).toISOString() : null,
    canChange: view.canChange,
  };
}
