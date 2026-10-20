import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AgentIdParamDto } from '@modules/account/dto/agent-id-param.dto';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { auditActorOf } from '@shared/audit';
import { CurrentSession, HumanSessionGuard, SessionAuthGuard } from '@shared/auth';

import {
  AgentAccessDto,
  CredentialAccessDto,
  CredentialIdParamDto,
  OnlyConnectedResultDto,
  UpdateAgentAccessBodyDto,
  UpdateCredentialAccessBodyDto,
} from '../dto/agent-access.dto';
import { AgentAccessService } from '../services/agent-access.service';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

/**
 * "What this agent can use" — the access policy, the agent rules and the
 * pinned tools (design spec §7.7, §7.9). Enforced on every MCP call whatever
 * URL it arrives through. An agent's own credential may read its access
 * (it plans with it) and never change it.
 */
@ApiTags('AgentAccess')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('agents/:agentId/access')
export class AgentAccessController {
  constructor(private readonly access: AgentAccessService) {}

  @Get()
  @TenantCache({
    ttl: 30,
    vary: 'agent',
    epochs: ['toolsets', 'agents', 'shared'],
    singleFlight: true,
  })
  @ApiOperation({ summary: 'Access, agent rules, pinned tools, and the combined result per tool' })
  @ApiResponse({ status: 200, type: AgentAccessDto })
  @ApiResponse({ status: 404, description: 'ACCOUNT_AGENT_NOT_FOUND — also another organization' })
  async get(
    @CurrentSession() session: McpSession,
    @Param() params: AgentIdParamDto,
  ): Promise<AgentAccessDto> {
    // A machine credential reads its own agent and no other.
    return this.access.get(
      session.organizationId,
      params.agentId,
      session.callerKind === McpCallerKind.AGENT ? session.agentId : null,
    );
  }

  @Patch()
  @UseGuards(HumanSessionGuard)
  @ApiOperation({ summary: 'Write a new policy version with this access, rules and pins' })
  @ApiResponse({ status: 200, type: AgentAccessDto })
  @ApiResponse({ status: 400, description: 'TOOLSET_ACCESS_INVALID' })
  @ApiResponse({ status: 429, description: 'TOOLSET_LIMIT_EXCEEDED (5 pinned tools)' })
  async patch(
    @CurrentSession() session: McpSession,
    @Param() params: AgentIdParamDto,
    @Body() body: UpdateAgentAccessBodyDto,
  ): Promise<AgentAccessDto> {
    return this.access.patch(session.organizationId, params.agentId, body, auditActorOf(session));
  }

  @Post('only-connected')
  @UseGuards(HumanSessionGuard)
  @ApiOperation({ summary: '"Only what\'s connected": restrict to the servers in use' })
  @ApiResponse({ status: 201, type: OnlyConnectedResultDto })
  async onlyConnected(
    @CurrentSession() session: McpSession,
    @Param() params: AgentIdParamDto,
  ): Promise<OnlyConnectedResultDto> {
    return this.access.onlyConnected(session.organizationId, params.agentId, auditActorOf(session));
  }
}

/** Per-key narrowing (API only): a key can only narrow its agent's access. */
@ApiTags('AgentAccess')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard, HumanSessionGuard)
@Controller('agent-credentials/:id/access')
export class CredentialAccessController {
  constructor(private readonly access: AgentAccessService) {}

  @Get()
  @ApiOperation({ summary: "One key's narrowing of its agent's access" })
  @ApiResponse({ status: 200, type: CredentialAccessDto })
  async get(
    @CurrentSession() session: McpSession,
    @Param() params: CredentialIdParamDto,
  ): Promise<CredentialAccessDto> {
    return this.access.getCredential(session.organizationId, params.id);
  }

  @Patch()
  @ApiOperation({ summary: 'Narrow one key; `accessMode: null` removes the narrowing' })
  @ApiResponse({ status: 200, type: CredentialAccessDto })
  @ApiResponse({ status: 404, description: 'ACCOUNT_CREDENTIAL_NOT_FOUND' })
  async patch(
    @CurrentSession() session: McpSession,
    @Param() params: CredentialIdParamDto,
    @Body() body: UpdateCredentialAccessBodyDto,
  ): Promise<CredentialAccessDto> {
    return this.access.patchCredential(
      session.organizationId,
      params.id,
      body,
      auditActorOf(session),
    );
  }
}
