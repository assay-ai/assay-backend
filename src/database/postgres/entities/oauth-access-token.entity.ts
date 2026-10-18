import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * One access token of an OAuth grant (spec §6.2). Opaque; only the SHA-256
 * hex digest is stored. Lives 3600 s.
 *
 * Hard-deleted by the cleanup job once dead; revocation is `revoked_at`, so
 * there is no soft delete.
 */
@Entity('oauth_access_tokens')
@Index('uq_oauth_access_tokens_token', ['tokenHash'], { unique: true })
@Index('idx_oauth_access_tokens_credential', ['credentialId', 'createdAt'])
export class OAuthAccessTokenEntity extends OrganizationScopedEntityWithoutSoftDelete {
  @Column({ name: 'credential_id', type: 'uuid' })
  credentialId: string;

  /** The refresh token issued with it. */
  @Column({ name: 'refresh_token_id', type: 'uuid', nullable: true })
  refreshTokenId: string | null;

  @Column({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash: string;

  @Column({ name: 'scope', type: 'varchar', length: 128 })
  scope: string;

  /** The MCP origin the token is bound to. */
  @Column({ name: 'audience', type: 'varchar', length: 512 })
  audience: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /** Set best-effort on first use. */
  @Column({ name: 'first_used_at', type: 'timestamptz', nullable: true })
  firstUsedAt: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;
}
