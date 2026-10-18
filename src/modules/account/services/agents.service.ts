import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentEntity } from '@database/postgres/entities/agent.entity';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { CursorPageDto } from '@shared/api';
import { AuditActor, AuditLogWriter } from '@shared/audit';

import { AgentDto, ListAgentsQueryDto } from '../dto/list-agents.dto';
import { AccountErrors } from '../errors/account.errors';

/**
 * `GET /api/v1/agents` — the agents in this organization, and
 * `PATCH /api/v1/agents/:agentId` — rename one.
 *
 * Reads the `agents` table (`AgentEntity`) — the table Privy login provisions
 * into.
 */
@Injectable()
export class AgentsService {
  constructor(
    private readonly agents: AgentRepository,
    private readonly credentials: AgentCredentialRepository,
    private readonly config: ConfigService,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    private readonly audit: AuditLogWriter,
  ) {}

  async list(organizationId: string, query: ListAgentsQueryDto): Promise<CursorPageDto<AgentDto>> {
    const page = await this.agents.list(organizationId, query);

    const counts = await this.credentialCounts(
      organizationId,
      page.items.map((agent) => agent.id),
    );

    // The chain is a property of the deployment, not of the wallet: a
    // freshly provisioned Privy agent has `chain_id = NULL` until a wallet is
    // linked, and the caller (the provider payout-address setup step) needs
    // *a* chain id to proceed, not a null it has to special-case.
    const defaultChainId = this.config.get<string>('auth.privy.defaultChainId', '');

    return page.map((agent) => this.toDto(agent, counts.get(agent.id) ?? 0, defaultChainId));
  }

  /**
   * Sets the label and nothing else, with an `agent.renamed` audit row in the
   * same transaction. The label is display text only (`McpSession.label`):
   * no authorisation reads it.
   *
   * An agent in another organization is the same 404 as a missing one. The
   * update is scoped by organization as well, so a row that moved between the
   * read and the write is not touched. Renaming to the current label writes
   * nothing.
   */
  async rename(
    organizationId: string,
    agentId: string,
    label: string,
    actor: AuditActor,
  ): Promise<AgentDto> {
    const agent = await this.agents.findById(agentId);
    if (!agent || agent.organizationId !== organizationId) {
      throw AccountErrors.agentNotFound({ agentId });
    }

    const defaultChainId = this.config.get<string>('auth.privy.defaultChainId', '');
    const counts = await this.credentialCounts(organizationId, [agentId]);
    const credentialCount = counts.get(agentId) ?? 0;

    if (agent.label === label) {
      return this.toDto(agent, credentialCount, defaultChainId);
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.update(AgentEntity, { id: agentId, organizationId }, { label });
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'agent.renamed',
        resourceType: 'agent',
        resourceId: agentId,
        before: { label: agent.label },
        after: { label },
      });
    });

    return this.toDto({ ...agent, label } as AgentEntity, credentialCount, defaultChainId);
  }

  private toDto(agent: AgentEntity, credentialCount: number, defaultChainId: string): AgentDto {
    return {
      agentId: agent.id,
      label: agent.label,
      // Nullable, not an invented empty string — see `AgentEntity.primaryAccountId`.
      agentAccount: agent.primaryAccountId,
      chainId: agent.chainId ?? defaultChainId,
      credentialCount,
    };
  }

  /**
   * Groups `agent_credentials` by `agents.id`.
   *
   * There is **no foreign key** between the two tables — `agent_credentials`
   * predates `agents` and nothing back-fills the join. So this can, honestly,
   * return zero for an agent whose credentials were seeded under a different
   * id (a demo credential minted before `agents` existed, for instance); that
   * is not a bug in this method, it is the absence of a constraint that does
   * not exist yet. See `test/unit/account/agents.service.spec.ts` for the
   * case spelled out.
   */
  private async credentialCounts(
    organizationId: string,
    agentIds: readonly string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (agentIds.length === 0) return counts;

    const rows = await this.credentials
      .createQueryBuilder('credential')
      .select('credential.agentId', 'agentId')
      .addSelect('COUNT(*)', 'count')
      .where('credential.organizationId = :organizationId', { organizationId })
      .andWhere('credential.agentId IN (:...agentIds)', { agentIds })
      .groupBy('credential.agentId')
      .getRawMany<{ agentId: string; count: string }>();

    for (const row of rows) {
      counts.set(row.agentId, Number(row.count));
    }
    return counts;
  }
}
