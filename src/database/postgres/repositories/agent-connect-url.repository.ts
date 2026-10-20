import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AgentConnectUrlEntity } from '../entities/agent-connect-url.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

@Injectable()
export class AgentConnectUrlRepository extends OrganizationScopedRepository<AgentConnectUrlEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(AgentConnectUrlEntity, dataSource);
  }

  /**
   * Record a URL handed out, or refresh its server name and client. The
   * creation time and the first call are kept: handing the same URL out again
   * is not a new connection.
   */
  async record(row: {
    organizationId: string;
    agentId: string;
    canonicalUrl: string;
    serverName: string | null;
    client: string | null;
  }): Promise<void> {
    // Raw SQL for the upsert; the tenant is the first parameter and the
    // conflict branch is scoped to it.
    await this.dataSource.query(
      `INSERT INTO "agent_connect_urls"
         ("organization_id", "agent_id", "canonical_url", "server_name", "client")
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ("agent_id", "canonical_url") DO UPDATE
         SET "server_name" = COALESCE(EXCLUDED."server_name", "agent_connect_urls"."server_name"),
             "client" = COALESCE(EXCLUDED."client", "agent_connect_urls"."client")
       WHERE "agent_connect_urls"."organization_id" = $1`,
      [row.organizationId, row.agentId, row.canonicalUrl, row.serverName, row.client],
    );
  }

  /** Stamp the first call through a URL. Idempotent; a URL never handed out is untouched. */
  async markFirstCall(
    organizationId: string,
    agentId: string,
    canonicalUrl: string,
  ): Promise<void> {
    await this.createQueryBuilder()
      .update(AgentConnectUrlEntity)
      .set({ firstCallAt: () => 'now()' })
      .where('organization_id = :organizationId', { organizationId })
      .andWhere('agent_id = :agentId', { agentId })
      .andWhere('canonical_url = :canonicalUrl', { canonicalUrl })
      .andWhere('first_call_at IS NULL')
      .execute();
  }
}
