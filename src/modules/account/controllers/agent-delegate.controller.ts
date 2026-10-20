import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import {
  AgentDelegateBindingDto,
  AgentDelegateBindingStatusDto,
  AgentDelegateStatusDto,
  BindDelegateBodyDto,
  CreateDelegateChallengeBodyDto,
  DelegateChallengeResponseDto,
} from '../dto/agent-delegate.dto';
import { AgentDelegateService } from '../services/agent-delegate.service';

/**
 * `/agents/me/delegate` — the calling AGENT credential binds the delegate key
 * it signs vouchers with, by proving it holds the key. Agent-only by
 * construction (`AgentDelegateService.assertAgent`): the binding is per
 * credential, and only the machine holding the key can sign the proof.
 */
@ApiTags('AgentCredentials')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('agents/me/delegate')
export class AgentDelegateController {
  constructor(private readonly delegates: AgentDelegateService) {}

  @Get()
  @ApiOperation({
    summary: "This credential's bound delegate key, if any, and its on-chain paid-call status",
  })
  @ApiResponse({ status: 200, type: AgentDelegateStatusDto })
  current(@CurrentSession() session: McpSession): Promise<AgentDelegateStatusDto> {
    return this.delegates.current(session);
  }

  @Get('status')
  @ApiOperation({
    summary: "This credential's bound delegate key, if any — from the database, no chain read",
  })
  @ApiResponse({ status: 200, type: AgentDelegateBindingStatusDto })
  status(@CurrentSession() session: McpSession): Promise<AgentDelegateBindingStatusDto> {
    return this.delegates.bindingStatus(session);
  }

  @Post('challenge')
  @ApiOperation({ summary: 'A single-use challenge the delegate key signs to prove possession' })
  @ApiResponse({ status: 201, type: DelegateChallengeResponseDto })
  challenge(
    @CurrentSession() session: McpSession,
    @Body() body: CreateDelegateChallengeBodyDto,
  ): Promise<DelegateChallengeResponseDto> {
    return this.delegates.challenge(session, body.delegate);
  }

  @Post()
  @ApiOperation({ summary: 'Bind the delegate key to this credential, given its signed challenge' })
  @ApiResponse({ status: 201, type: AgentDelegateBindingDto })
  bind(
    @CurrentSession() session: McpSession,
    @Body() body: BindDelegateBodyDto,
  ): Promise<AgentDelegateBindingDto> {
    return this.delegates.bind(session, body.challengeId, body.signature);
  }
}
