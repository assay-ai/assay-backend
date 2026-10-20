import { Column, Entity, Index } from 'typeorm';

import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/** How the authorization server came to know a client. */
export enum OAuthClientKind {
  /** A Client ID Metadata Document: `client_id` is the URL it was fetched from. */
  CIMD = 'CIMD',
  /** Dynamic client registration: `client_id` is `dcr_` + 22 base64url characters. */
  DCR = 'DCR',
  /** The `assay-mcp` proxy's own row, upserted at boot (its URL depends on `MCP_PUBLIC_URL`). */
  BUILTIN = 'BUILTIN',
}

/**
 * An OAuth client of the MCP authorization server (spec §6.2).
 *
 * Platform-wide: a client such as an MCP host is nobody's tenant data, and it
 * is resolved before any tenant is known. A credential issued to it references
 * it with `ON DELETE RESTRICT`, so a client row in use can never be removed.
 * Logo URIs are not stored or shown.
 */
@Entity('oauth_clients')
@Index('uq_oauth_clients_client_id', ['clientId'], { unique: true })
export class OAuthClientEntity extends AbstractEntityWithoutSoftDelete {
  @Column({ name: 'client_id', type: 'varchar', length: 512 })
  clientId: string;

  @Column({ name: 'kind', type: 'varchar', length: 8 })
  kind: OAuthClientKind;

  /** Control and bidi characters stripped before it is stored. */
  @Column({ name: 'client_name', type: 'varchar', length: 64 })
  clientName: string;

  /** Shown as text only, never as a link. */
  @Column({ name: 'client_uri', type: 'varchar', length: 512, nullable: true })
  clientUri: string | null;

  @Column({ name: 'redirect_uris', type: 'text', array: true })
  redirectUris: string[];

  /** The known metadata members only. */
  @Column({ name: 'metadata', type: 'jsonb' })
  metadata: Record<string, unknown>;

  /** CIMD: when the document was last fetched. */
  @Column({ name: 'fetched_at', type: 'timestamptz', nullable: true })
  fetchedAt: Date | null;

  /** CIMD: until when the fetched document is reused. */
  @Column({ name: 'cache_until', type: 'timestamptz', nullable: true })
  cacheUntil: Date | null;

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;
}
