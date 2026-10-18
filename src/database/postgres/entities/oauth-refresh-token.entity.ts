import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * One refresh token of an OAuth grant (spec §6.2, §6.3.11).
 *
 * One chain per credential: each rotation inserts a child whose `parent_id`
 * names the token it replaced and marks the parent `used_at`. Only the SHA-256
 * hex digest of the token is stored. A token lives 30 days from its issue, and
 * the credential's `expires_at` follows the newest one.
 *
 * Hard-deleted by the cleanup job once dead; revocation is `revoked_at`, so
 * there is no soft delete.
 */
@Entity('oauth_refresh_tokens')
@Index('uq_oauth_refresh_tokens_token', ['tokenHash'], { unique: true })
@Index('idx_oauth_refresh_tokens_credential', ['credentialId'])
@Index('idx_oauth_refresh_tokens_parent', ['parentId'])
@Index('idx_oauth_refresh_tokens_expires_dead', ['expiresAt'], {
  where: '"used_at" IS NOT NULL OR "revoked_at" IS NOT NULL',
})
export class OAuthRefreshTokenEntity extends OrganizationScopedEntityWithoutSoftDelete {
  @Column({ name: 'credential_id', type: 'uuid' })
  credentialId: string;

  @Column({ name: 'oauth_client_id', type: 'uuid' })
  oauthClientId: string;

  @Column({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash: string;

  /** The token this one replaced on rotation; `NULL` for the first of a chain. */
  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId: string | null;

  @Column({ name: 'scope', type: 'varchar', length: 128 })
  scope: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /** Set when the token is exchanged for its child. */
  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;
}
