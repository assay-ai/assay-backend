import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { auditActorOf } from '@shared/audit';
import {
  AllowedWhileBlocked,
  CurrentSession,
  HumanSessionGuard,
  SessionAuthGuard,
} from '@shared/auth';

import { AgentIdParamDto } from '../dto/agent-id-param.dto';
import {
  CreateAgentCredentialBodyDto,
  CreateAgentCredentialResponseDto,
} from '../dto/create-agent-credential.dto';
import {
  AgentCredentialDto,
  ListAgentCredentialsQueryDto,
} from '../dto/list-agent-credentials.dto';
import { RevokeAgentCredentialParamsDto } from '../dto/revoke-agent-credential.dto';
import { AgentCredentialsService } from '../services/agent-credentials.service';

/**
 * Machine tokens for an agent.
 *
 * `organizationId` comes from `@CurrentSession()` and nowhere else — see
 * `SessionAuthGuard`. The actor of a create or revoke (and `revokedBy`) is
 * `auditActorOf(session)` — the caller's own credential id: `McpSession`
 * carries no separate human-user identity yet, so this is the closest honest
 * answer to "who did this" until that identity model exists.
 */
@ApiTags('AgentCredentials')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('agents/:agentId/credentials')
export class AgentCredentialsController {
  constructor(private readonly credentials: AgentCredentialsService) {}

  @Get()
  @ApiOperation({ summary: 'Credentials for one agent, newest first' })
  @ApiCursorPage(AgentCredentialDto)
  async list(
    @CurrentSession() session: McpSession,
    @Param() params: AgentIdParamDto,
    @Query() query: ListAgentCredentialsQueryDto,
  ): Promise<CursorPageDto<AgentCredentialDto>> {
    return this.credentials.list(session.organizationId, params.agentId, query);
  }

  // Minting and revoking machine tokens is a person's act: an agent that
  // could mint itself a fresh token could outlive its own revocation.
  @Post()
  @UseGuards(HumanSessionGuard)
  @ApiOperation({ summary: 'Create a credential — the secret is returned exactly once' })
  @ApiResponse({
    status: 201,
    description: 'The credential, with its one-time secret',
    type: CreateAgentCredentialResponseDto,
  })
  async create(
    @CurrentSession() session: McpSession,
    @Param() params: AgentIdParamDto,
    @Body() body: CreateAgentCredentialBodyDto,
  ): Promise<CreateAgentCredentialResponseDto> {
    return this.credentials.create(
      session.organizationId,
      params.agentId,
      body,
      auditActorOf(session),
    );
  }

  @Delete(':id')
  @UseGuards(HumanSessionGuard)
  @AllowedWhileBlocked()
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke a credential — sets revoked_at, never deletes the row' })
  @ApiResponse({ status: 204, description: 'Revoked' })
  @ApiResponse({
    status: 404,
    description: 'No such credential under this agent, in this organization',
  })
  async revoke(
    @CurrentSession() session: McpSession,
    @Param() params: RevokeAgentCredentialParamsDto,
  ): Promise<void> {
    await this.credentials.revoke(
      session.organizationId,
      params.agentId,
      params.id,
      auditActorOf(session),
    );
  }
}
