import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  CurrentSession,
  HumanSessionGuard,
  SessionAuthGuard,
  isHumanCallerKind,
} from '@shared/auth';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { auditActorOf } from '@shared/audit';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';

import { SpendPolicyDto } from '../dto/get-spend-policy.dto';
import {
  ListSpendPolicyHistoryQueryDto,
  SpendPolicyHistoryEntryDto,
} from '../dto/list-spend-policy-history.dto';
import { UpdateSpendPolicyDto } from '../dto/update-spend-policy.dto';
import { SpendPolicyService } from '../services/spend-policy.service';

/** `GET`/`PATCH /api/v1/spend-policy`, `GET /api/v1/spend-policy/history` — the limits screen. */
@ApiTags('SpendPolicy')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('spend-policy')
export class SpendPolicyController {
  constructor(
    private readonly spendPolicy: SpendPolicyService,
    // The agent's resolved policy (and its version) is cached per organization epoch.
    private readonly epochs: AccessEpochService,
  ) {}

  @Get()
  @ApiOperation({ summary: "The session's agent policy, falling back to the organization default" })
  @ApiQuery({
    name: 'agentId',
    required: false,
    description:
      "Another agent of the caller's own organization, read by a person (the consent card's " +
      'agent select). An agent credential, or an id that is not one of the organization’s ' +
      "agents, reads the session's own agent: `subjectAgentId` names the agent read and " +
      '`requestedAgentIgnored` is true.',
  })
  @ApiResponse({ status: 200, description: 'The live policy', type: SpendPolicyDto })
  async get(
    @CurrentSession() session: McpSession,
    @Query('agentId') agentId?: unknown,
  ): Promise<SpendPolicyDto> {
    return this.spendPolicy.getForRequest(
      session.organizationId,
      session.agentId,
      agentId,
      isHumanCallerKind(session.callerKind),
    );
  }

  // The agent's own credential may READ its limits (it needs them to plan),
  // never write them: the policy exists to bound the agent.
  @Patch()
  @UseGuards(HumanSessionGuard)
  @ApiOperation({
    summary: "Write a new version of the session's agent policy (append-only)",
  })
  @ApiResponse({ status: 200, description: 'The new live policy', type: SpendPolicyDto })
  @ApiResponse({ status: 403, description: 'AUTH_HUMAN_SESSION_REQUIRED — an agent credential' })
  async patch(
    @CurrentSession() session: McpSession,
    @Body() body: UpdateSpendPolicyDto,
  ): Promise<SpendPolicyDto> {
    return this.spendPolicy.patch(
      session.organizationId,
      session.agentId,
      body,
      auditActorOf(session),
    );
  }

  /**
   * "Use account default" on `/limits` (BUG-BUY-CONNECT-05 part 2): drops the
   * agent's own policy, so the agent falls back to the organization default.
   * A person's decision, audited; an agent of another organization is a 404.
   */
  @Delete('agents/:agentId')
  @UseGuards(HumanSessionGuard)
  @ApiOperation({
    summary: "Drop an agent's own policy: the agent then uses the organization default",
  })
  @ApiResponse({
    status: 200,
    description: 'The policy now in force for the agent (the organization default)',
    type: SpendPolicyDto,
  })
  @ApiResponse({ status: 403, description: 'AUTH_HUMAN_SESSION_REQUIRED — an agent credential' })
  @ApiResponse({
    status: 404,
    description:
      'ACCOUNT_AGENT_NOT_FOUND — no such agent in this organization; SPEND_POLICY_NOT_FOUND — ' +
      'no organization default to fall back to',
  })
  @ApiResponse({
    status: 409,
    description:
      'SPEND_POLICY_DROP_REFUSED — `reason` ACCESS_DIFFERS (the agent has its own tool access or ' +
      'rules, kept in the same policy) or PAUSED (the agent is paused, the default is not)',
  })
  async dropAgentPolicy(
    @CurrentSession() session: McpSession,
    @Param('agentId', new ParseUUIDPipe()) agentId: string,
  ): Promise<SpendPolicyDto> {
    const dto = await this.spendPolicy.dropAgentPolicy(
      session.organizationId,
      agentId,
      auditActorOf(session),
    );
    await this.epochs.bump(session.organizationId);
    return dto;
  }

  @Get('history')
  @ApiOperation({ summary: 'Policy version history, newest first' })
  @ApiCursorPage(SpendPolicyHistoryEntryDto)
  async history(
    @CurrentSession() session: McpSession,
    @Query() query: ListSpendPolicyHistoryQueryDto,
  ): Promise<CursorPageDto<SpendPolicyHistoryEntryDto>> {
    return this.spendPolicy.history(session.organizationId, session.agentId, query);
  }
}
