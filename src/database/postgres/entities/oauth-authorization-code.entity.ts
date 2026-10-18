import { Column, Entity, Index } from 'typeorm';

import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/**
 * An authorization code, issued when a person approves a client on the
 * consent page and exchanged once at the token endpoint (spec §6.2).
 *
 * Platform-wide: the token endpoint looks a code up by its hash before it
 * knows the tenant. The code itself (`assay_ac_` + 32 random bytes) is never
 * stored, only its SHA-256 hex digest. It lives 60 s and is single use:
 * `used_at` and `credential_id` are set by the exchange.
 */
@Entity('oauth_authorization_codes')
@Index('uq_oauth_authorization_codes_code', ['codeHash'], { unique: true })
@Index('idx_oauth_authorization_codes_client', ['oauthClientId'])
@Index('idx_oauth_authorization_codes_expires', ['expiresAt'])
export class OAuthAuthorizationCodeEntity extends AbstractEntityWithoutSoftDelete {
  @Column({ name: 'code_hash', type: 'varchar', length: 64 })
  codeHash: string;

  @Column({ name: 'oauth_client_id', type: 'uuid' })
  oauthClientId: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'agent_id', type: 'uuid' })
  agentId: string;

  /** The name the credential is created with. */
  @Column({ name: 'credential_name', type: 'varchar', length: 128 })
  credentialName: string;

  /** The grant this approval replaces, when the person chose to replace one. */
  @Column({ name: 'replaces_credential_id', type: 'uuid', nullable: true })
  replacesCredentialId: string | null;

  /** The audit actor id of the human session that approved. */
  @Column({ name: 'approved_by', type: 'varchar', length: 128 })
  approvedBy: string;

  @Column({ name: 'redirect_uri', type: 'varchar', length: 2048 })
  redirectUri: string;

  /** PKCE S256 challenge. */
  @Column({ name: 'code_challenge', type: 'varchar', length: 64 })
  codeChallenge: string;

  @Column({ name: 'scope', type: 'varchar', length: 128 })
  scope: string;

  /** Always the MCP origin. */
  @Column({ name: 'resource', type: 'varchar', length: 512 })
  resource: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  /**
   * Set when a used code is presented again. The exchange that burned it
   * creates no grant once this is set; see migration 1762400000003.
   */
  @Column({ name: 'reuse_detected_at', type: 'timestamptz', nullable: true })
  reuseDetectedAt: Date | null;

  /** The credential the exchange created. */
  @Column({ name: 'credential_id', type: 'uuid', nullable: true })
  credentialId: string | null;
}
