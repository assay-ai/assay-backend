import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { auditActorOf } from '@shared/audit';
import { CurrentSession, HumanSessionGuard, SessionAuthGuard } from '@shared/auth';

import { AgentIdParamDto } from '../dto/agent-id-param.dto';
import { AgentDto, ListAgentsQueryDto } from '../dto/list-agents.dto';
import { UpdateAgentBodyDto } from '../dto/update-agent.dto';
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
