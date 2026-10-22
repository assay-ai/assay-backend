import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntity } from './organization-scoped.entity';

/** How a credential was obtained. Everything else about the row is the same. */
export enum CredentialIssuedVia {
  /** Created on the credentials screen; the row holds its token's hash and prefix. */
  API_KEY = 'API_KEY',
  /** An OAuth grant; its tokens live in `oauth_access_tokens` / `oauth_refresh_tokens`. */
  OAUTH = 'OAUTH',
}

/**
 * The machine tokens the credentials screens list and rotate.
 *
 * ## The secret is not in this table
 *
 * `token_hash` is a SHA-256 of the token; the token itself is returned exactly
 * once, at creation, and is not recoverable afterwards. A credentials screen
 * that can re-display a secret is a credentials screen that leaks every secret
 * the moment one session is stolen — and it removes the only reason rotation
 * exists.
 *
 * `prefix` is the first few characters, stored in clear, so the UI can show
 * `assay_live_8fK2…` next to "last used 3 minutes ago" and an operator can tell
 * which of four tokens is the one their CI is using. It is deliberately short
 * enough to be useless on its own.
 *
 * ## Revocation is a timestamp, not a delete
 *
 * A revoked credential must stay visible: "this token was revoked on the 3rd"
 * is the answer to the question someone is asking when they look. Deleting the
 * row answers it with silence, which reads identically to "this token never
 * existed" — the wrong conclusion during an incident.
 *
 * ## `rotated_from_id` makes rotation a chain rather than an event
 *
 * Rotation creates a new row pointing at the one it replaces, so the UI can
 * show a lineage and an operator can see that the token their deploy still
 * uses was superseded a week ago. Credentials issued through Privy later fill
 * in this same shape rather than replacing it.
 *
 * ## An OAuth grant is a row of this table too
 *
 * OAuth only changes how a credential is obtained (`issued_via`). A grant has
 * no token of its own, so its `prefix` and `token_hash` are `NULL` and its
 * `oauth_client_id` names the client; `ck_agent_credentials_issued_via` keeps
 * the two shapes apart. Limits, narrowing, revocation and audit are the same.
 */
@Entity('agent_credentials')
@Index('idx_agent_credentials_agent', ['organizationId', 'agentId'])
@Index('idx_agent_credentials_prefix', ['organizationId', 'prefix'])
@Index('idx_agent_credentials_oauth_live', ['agentId'], {
  where: `"issued_via" = 'OAUTH' AND "revoked_at" IS NULL`,
})
@Index('idx_agent_credentials_oauth_client', ['oauthClientId'], {
  where: `"oauth_client_id" IS NOT NULL`,
})
export class AgentCredentialEntity extends OrganizationScopedEntity {
  @Column({ name: 'agent_id', type: 'uuid' })
  agentId: string;

  /** Human label — "CI deploy", "local dev". */
  @Column({ name: 'name', type: 'varchar', length: 128 })
  name: string;

  @Column({ name: 'issued_via', type: 'varchar', length: 16, default: CredentialIssuedVia.API_KEY })
  issuedVia: CredentialIssuedVia;

  /** The OAuth client a grant was issued to; `NULL` for an API key. */
  @Column({ name: 'oauth_client_id', type: 'uuid', nullable: true })
  oauthClientId: string | null;

  /** Clear-text leading characters, for disambiguation only. `NULL` for an OAuth grant. */
  @Column({ name: 'prefix', type: 'varchar', length: 24, nullable: true })
  prefix: string | null;

  /** SHA-256 hex of the full token. The only copy we keep. `NULL` for an OAuth grant. */
  @Column({ name: 'token_hash', type: 'varchar', length: 128, nullable: true })
  tokenHash: string | null;

  /**
   * What this credential may do (`AgentScope`, enforced by
   * `SessionAuthGuard` and the MCP host), as an array rather than a bitmask or
   * a CSV. Fixed at creation; a value outside the vocabulary grants nothing.
   *
   * Postgres can index and query `text[]` containment directly, and a scope
   * added later does not renumber the ones already issued — which a bitmask
   * does, silently, to tokens already in customers' CI.
   */
  @Column({ name: 'scopes', type: 'text', array: true, default: () => `'{}'::text[]` })
  scopes: string[];

  /**
   * Updated on use, best-effort.
   *
   * Written on a coarse cadence rather than on every request: a synchronous
   * write here would put a row update on the hot path of every authenticated
   * call to serve a column whose UI only ever renders it as "3 minutes ago".
   * Each use is buffered in Redis by `LastSeenRecorder` and written in a batch
   * every 30 s; a reader shows the latest of this column and
   * `LastSeenRecorder.pending` (see `AgentCredentialsService.list`).
   */
  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ name: 'revoked_by', type: 'varchar', length: 128, nullable: true })
  revokedBy: string | null;

  /** The credential this one replaced, if it was created by a rotation. */
  @Column({ name: 'rotated_from_id', type: 'uuid', nullable: true })
  rotatedFromId: string | null;

  /**
   * The DELEGATE key this credential signs rail-B vouchers with (CAIP-10), once
   * the agent has proved it holds the key. It grants nothing on chain — the
   * payer's on-chain authorisation of the key does — and is NULL until bound.
   */
  @Column({ name: 'delegate_account', type: 'varchar', length: 256, nullable: true })
  delegateAccount: string | null;

  @Column({ name: 'delegate_bound_at', type: 'timestamptz', nullable: true })
  delegateBoundAt: Date | null;

  /**
   * A DELEGATE key the agent proved it holds while {@link delegateAccount} was
   * already bound (CAIP-10). It signs nothing yet: it replaces the bound key
   * only when the payer approves it on chain (`POST /escrow/delegates`), in
   * one UPDATE. A new binding never silently replaces a live one.
   */
  @Column({ name: 'pending_delegate_account', type: 'varchar', length: 256, nullable: true })
  pendingDelegateAccount: string | null;

  @Column({ name: 'pending_delegate_requested_at', type: 'timestamptz', nullable: true })
  pendingDelegateRequestedAt: Date | null;

  /**
   * Per-key narrowing of the agent's access (API only, design spec §7.7).
   * `NULL` narrows nothing; otherwise a second grant intersected with the
   * agent's, so a key can only ever narrow.
   */
  @Column({ name: 'access_mode', type: 'varchar', length: 16, nullable: true })
  accessMode: string | null;

  @Column({ name: 'allowed_toolsets', type: 'jsonb', nullable: true })
  allowedToolsets: unknown[] | null;

  @Column({ name: 'allowed_tool_ids', type: 'uuid', array: true, nullable: true })
  allowedToolIds: string[] | null;
}
