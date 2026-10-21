import { Injectable } from '@nestjs/common';

import { AuthErrors } from '@modules/auth/errors/auth.errors';
import {
  McpCallerKind,
  McpSession,
  storedCredentialIdOf,
} from '@modules/mcp/ports/mcp-session.port';
import { CursorPageDto } from '@shared/api';
import { isHumanCallerKind } from '@shared/auth';

import { agentHealth } from '../domain/agent-health';
import {
  AGENT_LIST_CREDENTIALS_LIMIT,
  AgentListInclude,
  AgentWithIncludesDto,
  ListAgentsQueryDto,
} from '../dto/list-agents.dto';
import {
  AgentCredentialsPage,
  ListAgentCredentialsQueryDto,
} from '../dto/list-agent-credentials.dto';
import { AgentCredentialsService } from './agent-credentials.service';
import { AgentsService } from './agents.service';

/**
 * `GET /agents`, with what `include` asks for: each agent's first page of
 * credentials and the key health derived from it, read for the whole page at
 * once (`AgentCredentialsService.firstPagesFor`) rather than one
 * `GET /agents/:agentId/credentials` per agent.
 *
 * Without `include` it is `AgentsService.list`, unchanged. With it, it nests
 * what the credentials route returns, under that route's rule
 * (`HumanOrOwnAgentGuard`): a person gets every agent's credentials and
 * health; a machine credential gets them for its own agent only, built from
 * its own key alone, and the other agents of the page come without either
 * field (BUG-DEMO-02). Nothing of another agent or another key is read for it.
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
    const person = isHumanCallerKind(session.callerKind);
    if (include.size > 0 && !person && session.callerKind !== McpCallerKind.AGENT) {
      throw AuthErrors.humanSessionRequired();
    }

    const page = await this.agents.list(session.organizationId, query);
    if (include.size === 0) return page;

    // Whose credentials this caller may read: every agent's for a person; for
    // an agent, its own key on its own agent only (and nothing when its agent
    // is not on this page, or it has no stored key).
    const readable = (agentId: string) => person || agentId === session.agentId;
    const credentials = person
      ? await this.credentials.firstPagesFor(
          session.organizationId,
          page.items.map((agent) => agent.agentId),
          AGENT_LIST_CREDENTIALS_LIMIT,
        )
      : await this.ownKey(
          session,
          page.items.some((agent) => agent.agentId === session.agentId),
        );
    const now = new Date();
    return page.map((agent) => {
      if (!readable(agent.agentId)) return agent;
      const own = credentials.get(agent.agentId) ?? { items: [], hasMore: false };
      return {
        ...agent,
        ...(include.has(AgentListInclude.CREDENTIALS) ? { credentials: own } : {}),
        ...(include.has(AgentListInclude.HEALTH) ? { health: agentHealth(own.items, now) } : {}),
      };
    });
  }

  /** An agent caller's own key, as the one-entry page `include` nests for its agent. */
  private async ownKey(
    session: McpSession,
    onPage: boolean,
  ): Promise<Map<string, AgentCredentialsPage>> {
    const credentialId = storedCredentialIdOf(session);
    if (!onPage || !credentialId) return new Map();
    const page = await this.credentials.list(
      session.organizationId,
      session.agentId,
      Object.assign(new ListAgentCredentialsQueryDto(), { limit: 1 }),
      { credentialId },
    );
    return new Map([[session.agentId, { items: page.items, hasMore: false }]]);
  }
}
