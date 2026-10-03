import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import { AgentDto, ListAgentsQueryDto } from '../dto/list-agents.dto';
import { AgentsService } from '../services/agents.service';

/** The agents in this organization. See `AgentsService`. */
@ApiTags('Agents')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  @ApiOperation({ summary: 'Agents in this organization' })
  @ApiCursorPage(AgentDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListAgentsQueryDto,
  ): Promise<CursorPageDto<AgentDto>> {
    return this.agents.list(session.organizationId, query);
  }
}
