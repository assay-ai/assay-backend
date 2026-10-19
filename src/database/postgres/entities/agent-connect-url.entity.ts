import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import { ORGANIZATION_SCOPE_COLUMN } from '../organization-scope/organization-scope.constants';

/**
 * A canonical MCP URL the Connect sheet handed an agent (design spec §7.2).
 *
 * Bookkeeping only — the "Waiting for first call" row and the remembered
 * client tab. Nothing is enforced from it: the URL is the connection.
 */
@Entity('agent_connect_urls')
export class AgentConnectUrlEntity {
  @PrimaryColumn({ name: 'agent_id', type: 'uuid' })
  agentId: string;

  @PrimaryColumn({ name: 'canonical_url', type: 'varchar', length: 2048 })
  canonicalUrl: string;

  @Column({ name: ORGANIZATION_SCOPE_COLUMN, type: 'uuid' })
  organizationId: string;

  /** The server name the sheet suggested, at most 9 characters. */
  @Column({ name: 'server_name', type: 'varchar', length: 56, nullable: true })
  serverName: string | null;

  /** The client tab: one of `CONNECT_CLIENTS` (`mcp-urls.dto.ts`). */
  @Column({ name: 'client', type: 'varchar', length: 24, nullable: true })
  client: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'first_call_at', type: 'timestamptz', nullable: true })
  firstCallAt: Date | null;
}
