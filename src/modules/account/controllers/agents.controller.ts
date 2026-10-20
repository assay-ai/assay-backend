import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { auditActorOf } from '@shared/audit';
import { CurrentSession, HumanSessionGuard, SessionAuthGuard } from '@shared/auth';

import { AgentIdParamDto } from '../dto/agent-id-param.dto';
import { AgentDto, AgentWithIncludesDto, ListAgentsQueryDto } from '../dto/list-agents.dto';
import { UpdateAgentBodyDto } from '../dto/update-agent.dto';
import { AgentListService } from '../services/agent-list.service';
import { AgentsService } from '../services/agents.service';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

/** The agents in this organization. See `AgentsService`. */
@ApiTags('Agents')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('agents')
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly agentList: AgentListService,
  ) {}

  // `include` nests what `GET /agents/:agentId/credentials` returns, so it is
  // that route's person-only read; the plain list stays open to an agent.
  @Get()
  @TenantCache({ ttl: 5, vary: 'org', epochs: ['agents'] })
  @ApiOperation({ summary: 'Agents in this organization' })
  @ApiCursorPage(AgentWithIncludesDto)
  @ApiResponse({
    status: 403,
    description: 'AUTH_HUMAN_SESSION_REQUIRED — `include` with an agent credential',
  })
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListAgentsQueryDto,
  ): Promise<CursorPageDto<AgentWithIncludesDto>> {
    return this.agentList.list(session, query);
  }

  // A person's act: an agent's machine credential must not rename the agent
  // its owner reads in the dashboard.
  @Patch(':agentId')
  @UseGuards(HumanSessionGuard)
  @ApiOperation({ summary: 'Rename an agent — changes its label and nothing else' })
  @ApiResponse({ status: 200, description: 'The renamed agent', type: AgentDto })
  @ApiResponse({ status: 404, description: 'No such agent in this organization' })
  async rename(
    @CurrentSession() session: McpSession,
    @Param() params: AgentIdParamDto,
    @Body() body: UpdateAgentBodyDto,
  ): Promise<AgentDto> {
    return this.agents.rename(
      session.organizationId,
      params.agentId,
      body.label,
      auditActorOf(session),
    );
  }
}
