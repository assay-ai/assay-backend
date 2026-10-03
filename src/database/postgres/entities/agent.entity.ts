import { Column, Entity, Index } from 'typeorm';

import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/**
 * A Privy identity, and the tenant it belongs to.
 *
 * This is the `agents` table the data model has described since before there
 * was a login, keyed by `privy_user_id`, with a `primary_account_id` for the
 * CAIP-10 account its calls spend. Until now the only place an agent existed
 * was `ConfigMcpSessionSource`'s JSON file, which is why `AgentsService` reads
 * a config snapshot and `agent_credentials.agent_id` points at nothing.
 *
 * ## Why one table and not `users` + `agents`
 *
 * The data model gives a Privy identity and an agent the same row, and
 * every consumer downstream already reads `McpSession.agentId` — nothing reads
 * a "user". A separate `users` table would introduce a second identity that no
 * column anywhere references, which is precisely the "scatter" to avoid.
 * Several agents per human is a real requirement later; the seam for it is the
 * unique index on `privy_user_id` (drop it, add a `user_id`), and every
 * consumer keeps reading `agentId` through that change.
 *
 * ## `organization_id` without `OrganizationScopedEntity`
 *
 * Deliberate, and the second documented exception after `operators`. This row
 * **is** the mapping from an external identity to a tenant, so it has to be
 * readable before the tenant is known — `OrganizationScopedRepository` throws
 * unless a query names `organizationId`, which here would mean knowing the
 * answer in order to ask the question. The column is still present, still
 * indexed, and every *other* read of this table (an organization's agent list)
 * filters on it.
 *
 * ## `primary_account_id` is nullable, and that is not a shortcut
 *
 * It is CAIP-10 — the account whose balance this agent's calls spend, and the
 * account a withdrawal must be authorised by. There is exactly one honest
 * source for it: a wallet the human actually controls. A freshly authenticated
 * Privy identity with no linked Solana wallet has no such account, and
 * inventing one (a derived address, a platform-owned account, the DID itself)
 * would put a value into `payment_intents.agent_account` that no key can ever
 * sign for. Null says "not yet"; `PrivyMcpSessionSource` refuses to build a
 * session on it with `AUTH_WALLET_NOT_LINKED`, which is the truth. Embedded
 * wallet creation is separate work.
 */
@Entity('agents')
@Index('idx_agents_organization', ['organizationId'])
export class AgentEntity extends AbstractEntityWithoutSoftDelete {
  /**
   * The tenant. Not `OrganizationScopedEntity`'s column — see the docstring.
   */
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  /**
   * The Privy DID (`did:privy:…`), unique across the platform.
   *
   * The `sub` claim of a verified access token, and the only join between a
   * token and a row here. Stored in clear: a DID is a public identifier, not a
   * secret — unlike `agent_credentials.token_hash`, which is a digest because
   * the thing it indexes *is* the secret.
   */
  @Index('idx_agents_privy_user_id', { unique: true })
  @Column({ name: 'privy_user_id', type: 'varchar', length: 128 })
  privyUserId: string;

  /** Best known email, for the dashboard and for naming a new organization. Never authorisation. */
  @Column({ name: 'email', type: 'varchar', length: 320, nullable: true })
  email: string | null;

  /** Human label for logs and the dashboard, per `McpSession.label`. */
  @Column({ name: 'label', type: 'varchar', length: 128, nullable: true })
  label: string | null;

  /**
   * `ACTIVE` | `SUSPENDED`.
   *
   * Read on every resolve, never cached into a token — same property
   * `operators.status` exists for: suspending an agent has to take effect on
   * the next request, without waiting for a credential to expire.
   */
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'ACTIVE' })
  status: string;

  /** CAIP-10. Nullable until a wallet is linked — see the docstring. */
  @Column({ name: 'primary_account_id', type: 'varchar', length: 256, nullable: true })
  primaryAccountId: string | null;

  /** CAIP-2. The chain `primary_account_id` lives on; null while that is null. */
  @Column({ name: 'chain_id', type: 'varchar', length: 128, nullable: true })
  chainId: string | null;

  /**
   * Updated on login, best-effort.
   *
   * Written on a coarse cadence and never awaited on the refusal path, for the
   * same reason `agent_credentials.last_used_at` is: a row update on the hot
   * path of every authenticated call is a lot of writes to serve a column the
   * UI renders as "3 minutes ago".
   */
  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;
}
