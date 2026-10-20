import { Injectable } from '@nestjs/common';

import { AuthErrors } from '@modules/auth/errors/auth.errors';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { CursorPageDto } from '@shared/api';
import { isHumanCallerKind } from '@shared/auth';

import { agentHealth } from '../domain/agent-health';
import {
  AGENT_LIST_CREDENTIALS_LIMIT,
  AgentListInclude,
  AgentWithIncludesDto,
  ListAgentsQueryDto,
} from '../dto/list-agents.dto';
import { AgentCredentialsService } from './agent-credentials.service';
import { AgentsService } from './agents.service';

/**
 * `GET /agents`, with what `include` asks for: each agent's first page of
 * credentials and the key health derived from it, read for the whole page at
 * once (`AgentCredentialsService.firstPagesFor`) rather than one
 * `GET /agents/:agentId/credentials` per agent.
 *
 * Without `include` it is `AgentsService.list`, unchanged. With it, it is a
 * person's read: it nests what the credentials route returns, and that route
 * is `HumanSessionGuard`'s, so a machine credential is refused the same way.
 */
@Injectable()
export class AgentListService {
  constructor(
    private readonly agents: AgentsService,
    private readonly credentials: AgentCredentialsService,
  ) {}

  async list(
    session: McpSession,
    query: ListAgentsQueryDto,
  ): Promise<CursorPageDto<AgentWithIncludesDto>> {
    const include = new Set(query.include ?? []);
    if (include.size > 0 && !isHumanCallerKind(session.callerKind)) {
      throw AuthErrors.humanSessionRequired();
    }

    const page = await this.agents.list(session.organizationId, query);
    if (include.size === 0) return page;

    const credentials = await this.credentials.firstPagesFor(
      session.organizationId,
      page.items.map((agent) => agent.agentId),
      AGENT_LIST_CREDENTIALS_LIMIT,
    );
    const now = new Date();
    return page.map((agent) => {
      const own = credentials.get(agent.agentId) ?? { items: [], hasMore: false };
      return {
        ...agent,
        ...(include.has(AgentListInclude.CREDENTIALS) ? { credentials: own } : {}),
        ...(include.has(AgentListInclude.HEALTH) ? { health: agentHealth(own.items, now) } : {}),
      };
    });
  }
}
